/*
 * RAKSHAK-KAPHA :: Module 1 -- ESP32 Firmware
 * ============================================================================
 * Off-grid Edge-AI cardiopulmonary triage node ("PneumoPulse" engine).
 *
 * BOARD:   ESP32 Dev Module (Dual-core Xtensa LX6), Arduino-ESP32 core.
 * LIBS (exact, tested against arduino-esp32 core 2.0.17 / 3.0.x):
 *   BLEDevice.h / BLEUtils.h / BLEScan.h / BLEAdvertisedDevice.h / BLEClient.h
 *       -- bundled with arduino-esp32 core (no separate install required)
 *   Adafruit_NeoPixel.h  == 1.12.3   (Library Manager: "Adafruit NeoPixel")
 *
 * PINS:
 *   PIN_NEOPIXEL = GPIO 18  (1x WS2812B, GRB, 800 kHz)
 *   PIN_BUZZER   = GPIO 19  (active buzzer, software-driven tone/pulse)
 *   PIN_MODE_BTN = GPIO 4   (tactile button, INPUT_PULLUP, debounced)
 *
 * Board settings: Tools > Board > "ESP32 Dev Module", Upload Speed 921600,
 * Flash Frequency 80MHz, Partition Scheme "Default", Core Debug Level "None".
 * ============================================================================
 */

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>
#include <BLEClient.h>
#include <Adafruit_NeoPixel.h>

// ---------------------------------------------------------------------------
// Pin mapping
// ---------------------------------------------------------------------------
#define PIN_NEOPIXEL   18
#define PIN_BUZZER     19
#define PIN_MODE_BTN   4

#define NEOPIXEL_COUNT 1

// ---------------------------------------------------------------------------
// BLE GATT identifiers (Bluetooth SIG standard Heart Rate Service)
// ---------------------------------------------------------------------------
static BLEUUID HR_SERVICE_UUID((uint16_t)0x180D);
static BLEUUID HR_MEASUREMENT_CHAR_UUID((uint16_t)0x2A37);

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------
#define TRIAGE_EVAL_INTERVAL_MS      2000UL
#define TELEMETRY_INTERVAL_MS        1000UL
#define BLE_SCAN_WINDOW_S            5
#define BLE_RECONNECT_BACKOFF_MS     3000UL
#define BUTTON_DEBOUNCE_MS           40UL
#define ASHA_SCREEN_DURATION_MS      10000UL
#define ASHA_LATCH_DURATION_MS       5000UL

// ---------------------------------------------------------------------------
// Global hardware objects
// ---------------------------------------------------------------------------
Adafruit_NeoPixel pixel(NEOPIXEL_COUNT, PIN_NEOPIXEL, NEO_GRB + NEO_KHZ800);

static BLEScan       *bleScan            = nullptr;
static BLEClient     *bleClient          = nullptr;
static BLEAdvertisedDevice *targetDevice = nullptr;
static bool           bleConnected       = false;
static bool           bleConnectPending  = false;
static unsigned long  lastReconnectAttemptMs = 0;

// ---------------------------------------------------------------------------
// Firmware modes
// ---------------------------------------------------------------------------
enum FirmwareMode : uint8_t { MODE_CONTINUOUS = 0, MODE_ASHA_SCREEN = 1 };
static FirmwareMode currentMode = MODE_CONTINUOUS;
static unsigned long ashaScreenStartMs = 0;
static unsigned long ashaLatchStartMs  = 0;
static bool           ashaLatched       = false;
static uint8_t         ashaLatchedTriage = 0;

// Aggregate-median buffer for ASHA screening window (10 s @ ~10 Hz sampling)
#define ASHA_BUFFER_LEN 128
static uint8_t ashaTriageBuf[ASHA_BUFFER_LEN];
static uint16_t ashaTriageBufIdx = 0;

// ---------------------------------------------------------------------------
// Vitals state
// ---------------------------------------------------------------------------
struct Vitals {
  float hr;     // bpm
  float spo2;   // %
  float rr;     // breaths per minute
  float hrv;    // RMSSD, ms
  float temp;   // deg C
  int   co2;    // ppm
};
static Vitals vitals = {72.0f, 98.0f, 15.0f, 45.0f, 36.6f, 420};
static uint8_t currentTriage = 0; // 0=GREEN 1=YELLOW 2=RED

// ---------------------------------------------------------------------------
// RR-interval / HRV (RMSSD) rolling buffer
// ---------------------------------------------------------------------------
#define RR_BUFFER_LEN 32
static uint16_t rrIntervalBuf[RR_BUFFER_LEN]; // raw 1/1024 s units
static uint8_t  rrBufCount = 0;
static uint8_t  rrBufHead  = 0;
static bool     haveLastRR = false;
static uint16_t lastRRRaw  = 0;

// ---------------------------------------------------------------------------
// Button debouncing
// ---------------------------------------------------------------------------
static bool          lastRawButtonState   = HIGH;
static bool          stableButtonState    = HIGH;
static unsigned long lastButtonEdgeMs     = 0;

// ---------------------------------------------------------------------------
// Non-blocking LED/buzzer state
// ---------------------------------------------------------------------------
static unsigned long lastLedToggleMs   = 0;
static bool           ledToggleOn       = false;
static unsigned long lastBuzzerEventMs = 0;
static bool           buzzerActiveTone  = false;
static unsigned long  buzzerToneStartMs = 0;
static unsigned long  buzzerToneLenMs   = 0;

static unsigned long lastTriageEvalMs    = 0;
static unsigned long lastTelemetryMs     = 0;

// =============================================================================
// Forward declarations
// =============================================================================
void startBleScan();
void tryConnectToDevice();
void updateRRAndHRV(uint16_t rrRaw1024);
float computeRMSSD();
void generateSyntheticVitals();
void evaluateTriage();
void driveFeedback(unsigned long nowMs);
void printTelemetry(unsigned long latencyMs);
void handleModeButton();
void enterAshaScreen();
void runAshaScreenLogic(unsigned long nowMs);

// =============================================================================
// BLE: Advertised-device scan callback
// =============================================================================
class KaphaAdvertisedDeviceCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) override {
    if (advertisedDevice.haveServiceUUID() &&
        advertisedDevice.isAdvertisingService(HR_SERVICE_UUID)) {
      Serial.print("[BLE] Found HR service device: ");
      Serial.println(advertisedDevice.toString().c_str());
      BLEDevice::getScan()->stop();
      if (targetDevice != nullptr) {
        delete targetDevice;
        targetDevice = nullptr;
      }
      targetDevice = new BLEAdvertisedDevice(advertisedDevice);
      bleConnectPending = true;
    }
  }
};

// =============================================================================
// BLE: Client connection state callback
// =============================================================================
class KaphaClientCallbacks : public BLEClientCallbacks {
  void onConnect(BLEClient *client) override {
    (void)client;
    bleConnected = true;
    Serial.println("[BLE] Connected.");
  }
  void onDisconnect(BLEClient *client) override {
    (void)client;
    bleConnected = false;
    Serial.println("[BLE] Disconnected -- will auto-reconnect.");
  }
};

// =============================================================================
// BLE: Heart Rate Measurement notification handler
//
// Flag byte bit layout (Bluetooth SIG GATT Heart Rate Measurement spec):
//   Bit 0: 0 = HR value is UINT8, 1 = HR value is UINT16
//   Bit 1-2: Sensor Contact status (ignored here)
//   Bit 3: Energy Expended present (UINT16, if set)
//   Bit 4: RR-Interval present (one or more UINT16 values, 1/1024 s units)
// =============================================================================
static void hrMeasurementNotifyCallback(BLERemoteCharacteristic *characteristic,
                                         uint8_t *data, size_t length,
                                         bool isNotify) {
  (void)characteristic;
  (void)isNotify;
  if (length < 2) return;

  size_t idx = 0;
  uint8_t flags = data[idx++];
  bool hr16Bit         = (flags & 0x01) != 0;
  bool energyPresent   = (flags & 0x08) != 0;
  bool rrIntervalPresent = (flags & 0x10) != 0;

  uint16_t hrValue;
  if (hr16Bit) {
    if (idx + 2 > length) return;
    hrValue = (uint16_t)data[idx] | ((uint16_t)data[idx + 1] << 8);
    idx += 2;
  } else {
    if (idx + 1 > length) return;
    hrValue = data[idx];
    idx += 1;
  }
  vitals.hr = (float)hrValue;

  if (energyPresent) {
    idx += 2; // Energy Expended (UINT16) -- not consumed by this node
  }

  if (rrIntervalPresent) {
    while (idx + 2 <= length) {
      uint16_t rrRaw = (uint16_t)data[idx] | ((uint16_t)data[idx + 1] << 8);
      idx += 2;
      updateRRAndHRV(rrRaw);
    }
  }
}

// =============================================================================
// RR-interval ingestion -> rolling RMSSD (HRV) computation
// =============================================================================
void updateRRAndHRV(uint16_t rrRaw1024) {
  rrIntervalBuf[rrBufHead] = rrRaw1024;
  rrBufHead = (rrBufHead + 1) % RR_BUFFER_LEN;
  if (rrBufCount < RR_BUFFER_LEN) rrBufCount++;
  vitals.hrv = computeRMSSD();
}

// RMSSD = sqrt( mean( (RR[i] - RR[i-1])^2 ) ), expressed in milliseconds.
// Raw units are 1/1024 s; convert to ms via (raw * 1000.0 / 1024.0).
float computeRMSSD() {
  if (rrBufCount < 2) return vitals.hrv; // insufficient data, hold last value

  double sumSqDiff = 0.0;
  uint16_t nDiffs = 0;
  // Walk the circular buffer in chronological order.
  uint8_t start = (rrBufHead + RR_BUFFER_LEN - rrBufCount) % RR_BUFFER_LEN;
  int32_t prevMs = -1;
  for (uint8_t k = 0; k < rrBufCount; k++) {
    uint8_t bufIdx = (start + k) % RR_BUFFER_LEN;
    int32_t curMs = (int32_t)((rrIntervalBuf[bufIdx] * 1000.0) / 1024.0);
    if (prevMs >= 0) {
      double diff = (double)(curMs - prevMs);
      sumSqDiff += diff * diff;
      nDiffs++;
    }
    prevMs = curMs;
  }
  if (nDiffs == 0) return vitals.hrv;
  return (float)sqrt(sumSqDiff / (double)nDiffs);
}

// =============================================================================
// BLE lifecycle
// =============================================================================
void startBleScan() {
  Serial.println("[BLE] Scanning for Heart Rate Service (0x180D) ...");
  bleScan->start(BLE_SCAN_WINDOW_S, false);
}

void tryConnectToDevice() {
  if (targetDevice == nullptr) return;

  Serial.print("[BLE] Connecting to: ");
  Serial.println(targetDevice->getAddress().toString().c_str());

  if (bleClient == nullptr) {
    bleClient = BLEDevice::createClient();
    bleClient->setClientCallbacks(new KaphaClientCallbacks());
  }

  if (!bleClient->connect(targetDevice)) {
    Serial.println("[BLE] Connect failed, will retry.");
    bleConnectPending = false;
    return;
  }

  BLERemoteService *remoteService = bleClient->getService(HR_SERVICE_UUID);
  if (remoteService == nullptr) {
    Serial.println("[BLE] HR service not found on peer, disconnecting.");
    bleClient->disconnect();
    bleConnectPending = false;
    return;
  }

  BLERemoteCharacteristic *remoteChar =
      remoteService->getCharacteristic(HR_MEASUREMENT_CHAR_UUID);
  if (remoteChar == nullptr) {
    Serial.println("[BLE] HR Measurement characteristic not found.");
    bleClient->disconnect();
    bleConnectPending = false;
    return;
  }

  if (remoteChar->canNotify()) {
    remoteChar->registerForNotify(hrMeasurementNotifyCallback);
  }

  bleConnected = true;
  bleConnectPending = false;
  Serial.println("[BLE] Subscribed to Heart Rate Measurement notifications.");
}

// =============================================================================
// Synthetic deterministic vitals generator (BLE-disconnected fail-safe)
//
// Deterministic function of elapsed runtime (millis()) only -- no random() --
// so behavior is reproducible run-to-run for demo/judging purposes. Produces
// a slow sinusoidal drift plus a periodic "spike" episode so downstream
// triage-state transitions are visibly exercised.
// =============================================================================
void generateSyntheticVitals() {
  float tSec = millis() / 1000.0f;

  // Base circadian-like slow drift (period ~90s) around healthy resting values.
  float driftHr   = 72.0f + 6.0f  * sinf(tSec * (2.0f * PI / 90.0f));
  float driftSpo2 = 97.5f + 1.0f  * sinf(tSec * (2.0f * PI / 130.0f));
  float driftRr   = 15.0f + 1.5f  * sinf(tSec * (2.0f * PI / 60.0f));

  // Periodic simulated exertion/decompensation spike every 45s, lasting ~8s,
  // used to exercise YELLOW/RED states without external hardware attached.
  float spikePhase = fmodf(tSec, 45.0f);
  float spike = 0.0f;
  if (spikePhase < 8.0f) {
    spike = sinf((spikePhase / 8.0f) * PI); // smooth 0->1->0 bump
  }

  vitals.hr   = driftHr + spike * 55.0f;              // up to ~127 bpm at peak
  vitals.spo2 = driftSpo2 - spike * 12.0f;             // down to ~85% at peak
  vitals.rr   = driftRr + spike * 15.0f;               // up to ~30 rpm at peak
  vitals.temp = 36.6f + spike * 0.6f;

  // CO2 (breathing-zone ambient quality) and respiration correlate with the
  // same spike so a single synthetic scenario stresses all triage inputs.
  vitals.co2  = (int)(450.0f + spike * 2600.0f + 30.0f * sinf(tSec * 0.05f));

  // Synthetic HRV: healthy vagal tone at rest, collapses during the spike
  // (sympathetic surge), mirroring the acute-decompensation physiology this
  // node is designed to catch early.
  vitals.hrv = 48.0f - spike * 38.0f + 3.0f * sinf(tSec * 0.3f);
  if (vitals.hrv < 4.0f) vitals.hrv = 4.0f;
}

// =============================================================================
// Deterministic mSTaRT-derived triage classification
//
// GREEN  (0, Minimal):   SpO2>=95, HR 55-100,  RR 12-20,  CO2 <1000
// YELLOW (1, Delayed):   SpO2 90-94, HR 101-125, RR 21-28, or CO2 1000-2500
// RED    (2, Immediate): SpO2<90, HR>125 or <50, RR>28 or <10, or CO2>2500
// Worst-class-wins: RED conditions checked first, then YELLOW, else GREEN.
// =============================================================================
uint8_t classifyTriage(float hr, float spo2, float rr, int co2) {
  bool isRed = (spo2 < 90.0f) || (hr > 125.0f) || (hr < 50.0f) ||
               (rr > 28.0f) || (rr < 10.0f) || (co2 > 2500);
  if (isRed) return 2;

  bool isYellow = (spo2 >= 90.0f && spo2 <= 94.0f) ||
                  (hr >= 101.0f && hr <= 125.0f) ||
                  (rr >= 21.0f && rr <= 28.0f) ||
                  (co2 >= 1000 && co2 <= 2500);
  if (isYellow) return 1;

  return 0;
}

void evaluateTriage() {
  if (!bleConnected) {
    generateSyntheticVitals();
  }
  currentTriage = classifyTriage(vitals.hr, vitals.spo2, vitals.rr, vitals.co2);
}

// =============================================================================
// Non-blocking LED + buzzer feedback (continuous mode)
// =============================================================================
void setPixelRGB(uint8_t r, uint8_t g, uint8_t b) {
  pixel.setPixelColor(0, pixel.Color(r, g, b));
  pixel.show();
}

void driveContinuousFeedback(unsigned long nowMs) {
  switch (currentTriage) {
    case 0: // GREEN: solid green, silent buzzer
      setPixelRGB(0, 255, 0);
      noTone(PIN_BUZZER);
      digitalWrite(PIN_BUZZER, LOW);
      break;

    case 1: { // YELLOW: solid amber, 50ms chirp every 4s
      setPixelRGB(255, 140, 0);
      if (nowMs - lastBuzzerEventMs >= 4000UL) {
        lastBuzzerEventMs = nowMs;
        buzzerActiveTone = true;
        buzzerToneStartMs = nowMs;
        buzzerToneLenMs = 50UL;
      }
      if (buzzerActiveTone) {
        if (nowMs - buzzerToneStartMs < buzzerToneLenMs) {
          digitalWrite(PIN_BUZZER, HIGH);
        } else {
          digitalWrite(PIN_BUZZER, LOW);
          buzzerActiveTone = false;
        }
      }
      break;
    }

    case 2: { // RED: rapid flash red (200ms toggle), loud oscillating alarm
      if (nowMs - lastLedToggleMs >= 200UL) {
        lastLedToggleMs = nowMs;
        ledToggleOn = !ledToggleOn;
      }
      if (ledToggleOn) {
        setPixelRGB(255, 0, 0);
      } else {
        setPixelRGB(0, 0, 0);
      }
      // Oscillating alarm tone: square-wave frequency sweep 1500-2500 Hz.
      {
        unsigned long cyclePos = nowMs % 400UL;
        int freq = 1500 + (int)((cyclePos / 400.0) * 1000.0);
        tone(PIN_BUZZER, freq);
      }
      break;
    }

    default:
      break;
  }
}

// =============================================================================
// Button handling (software debounce) + mode transition
// =============================================================================
void handleModeButton() {
  bool rawState = digitalRead(PIN_MODE_BTN);
  unsigned long nowMs = millis();

  if (rawState != lastRawButtonState) {
    lastButtonEdgeMs = nowMs;
    lastRawButtonState = rawState;
  }

  if ((nowMs - lastButtonEdgeMs) > BUTTON_DEBOUNCE_MS) {
    if (rawState != stableButtonState) {
      stableButtonState = rawState;
      // INPUT_PULLUP: pressed == LOW. Trigger on press edge only.
      if (stableButtonState == LOW && currentMode == MODE_CONTINUOUS) {
        enterAshaScreen();
      }
    }
  }
}

void enterAshaScreen() {
  Serial.println("[MODE] Entering MODE_ASHA_SCREEN (10s diagnostic window).");
  currentMode = MODE_ASHA_SCREEN;
  ashaScreenStartMs = millis();
  ashaTriageBufIdx = 0;
  memset(ashaTriageBuf, 0, sizeof(ashaTriageBuf));
  ashaLatched = false;
}

// Simple insertion-sort median (buffer is tiny: <=128 elements, bounded time).
uint8_t medianOfTriageBuf(uint8_t *buf, uint16_t n) {
  uint8_t sorted[ASHA_BUFFER_LEN];
  memcpy(sorted, buf, n * sizeof(uint8_t));
  for (uint16_t i = 1; i < n; i++) {
    uint8_t key = sorted[i];
    int16_t j = (int16_t)i - 1;
    while (j >= 0 && sorted[j] > key) {
      sorted[j + 1] = sorted[j];
      j--;
    }
    sorted[j + 1] = key;
  }
  return sorted[n / 2];
}

void runAshaScreenLogic(unsigned long nowMs) {
  unsigned long elapsed = nowMs - ashaScreenStartMs;

  if (!ashaLatched) {
    if (elapsed < ASHA_SCREEN_DURATION_MS) {
      // Rapid cyan pulsing LED at ~5 Hz while sampling continuously.
      unsigned long cyclePos = nowMs % 200UL;
      uint8_t brightness = (uint8_t)(128 + 127 * sinf((cyclePos / 200.0f) * 2 * PI));
      setPixelRGB(0, brightness, brightness);

      // Sample continuously at ~10 Hz into the aggregate buffer.
      static unsigned long lastSampleMs = 0;
      if (nowMs - lastSampleMs >= 100UL) {
        lastSampleMs = nowMs;
        evaluateTriage();
        if (ashaTriageBufIdx < ASHA_BUFFER_LEN) {
          ashaTriageBuf[ashaTriageBufIdx++] = currentTriage;
        }
      }
    } else {
      // Window complete: compute aggregate median risk and latch result.
      uint8_t n = (ashaTriageBufIdx == 0) ? 1 : ashaTriageBufIdx;
      if (ashaTriageBufIdx == 0) ashaTriageBuf[0] = currentTriage;
      ashaLatchedTriage = medianOfTriageBuf(ashaTriageBuf, n);
      ashaLatched = true;
      ashaLatchStartMs = nowMs;
      Serial.print("[MODE] ASHA screen complete. Aggregate median triage class: ");
      Serial.println(ashaLatchedTriage);
    }
  } else {
    unsigned long latchElapsed = nowMs - ashaLatchStartMs;
    if (latchElapsed < ASHA_LATCH_DURATION_MS) {
      // Flash the latched result color with confirmation beeps.
      unsigned long cyclePos = latchElapsed % 500UL;
      bool on = cyclePos < 250UL;
      if (on) {
        switch (ashaLatchedTriage) {
          case 0: setPixelRGB(0, 255, 0); break;
          case 1: setPixelRGB(255, 140, 0); break;
          case 2: setPixelRGB(255, 0, 0); break;
        }
        if (cyclePos < 60UL) {
          tone(PIN_BUZZER, 2000);
        } else {
          noTone(PIN_BUZZER);
          digitalWrite(PIN_BUZZER, LOW);
        }
      } else {
        setPixelRGB(0, 0, 0);
        noTone(PIN_BUZZER);
        digitalWrite(PIN_BUZZER, LOW);
      }
    } else {
      Serial.println("[MODE] Returning to MODE_CONTINUOUS.");
      currentMode = MODE_CONTINUOUS;
      noTone(PIN_BUZZER);
      digitalWrite(PIN_BUZZER, LOW);
    }
  }
}

// =============================================================================
// Telemetry
// =============================================================================
void printTelemetry(unsigned long latencyMs) {
  const char *modeStr =
      (currentMode == MODE_CONTINUOUS) ? "CONTINUOUS" : "ASHA_SCREEN";

  Serial.print("{\"id\":\"KAPHA-01\",");
  Serial.print("\"hr\":");
  Serial.print(vitals.hr, 1);
  Serial.print(",\"spo2\":");
  Serial.print(vitals.spo2, 1);
  Serial.print(",\"rr\":");
  Serial.print(vitals.rr, 1);
  Serial.print(",\"hrv\":");
  Serial.print(vitals.hrv, 1);
  Serial.print(",\"temp\":");
  Serial.print(vitals.temp, 1);
  Serial.print(",\"co2\":");
  Serial.print(vitals.co2);
  Serial.print(",\"triage\":");
  Serial.print(currentTriage);
  Serial.print(",\"mode\":\"");
  Serial.print(modeStr);
  Serial.print("\",\"lat_ms\":");
  Serial.print(latencyMs);
  Serial.println("}");
}

// =============================================================================
// Setup
// =============================================================================
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("[BOOT] RAKSHAK-KAPHA node initializing ...");

  pinMode(PIN_MODE_BTN, INPUT_PULLUP);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);

  pixel.begin();
  pixel.setBrightness(180);
  setPixelRGB(0, 0, 40); // dim blue: boot/initializing indicator
  delay(300);

  BLEDevice::init("KAPHA-01");
  bleScan = BLEDevice::getScan();
  bleScan->setAdvertisedDeviceCallbacks(new KaphaAdvertisedDeviceCallbacks());
  bleScan->setActiveScan(true);
  bleScan->setInterval(100);
  bleScan->setWindow(99);
  startBleScan();

  lastTriageEvalMs = millis();
  lastTelemetryMs  = millis();
  lastReconnectAttemptMs = millis();

  Serial.println("[BOOT] Ready. MODE_CONTINUOUS active.");
}

// =============================================================================
// Main loop (fully non-blocking)
// =============================================================================
void loop() {
  unsigned long loopStartMs = millis();

  handleModeButton();

  // BLE connect / reconnect supervision.
  if (bleConnectPending) {
    tryConnectToDevice();
  } else if (!bleConnected &&
             (loopStartMs - lastReconnectAttemptMs) >= BLE_RECONNECT_BACKOFF_MS) {
    lastReconnectAttemptMs = loopStartMs;
    startBleScan();
  }

  if (currentMode == MODE_CONTINUOUS) {
    if (loopStartMs - lastTriageEvalMs >= TRIAGE_EVAL_INTERVAL_MS) {
      lastTriageEvalMs = loopStartMs;
      evaluateTriage();
    }
    driveContinuousFeedback(loopStartMs);
  } else {
    runAshaScreenLogic(loopStartMs);
  }

  if (loopStartMs - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = loopStartMs;
    unsigned long latencyMs = millis() - loopStartMs;
    printTelemetry(latencyMs);
  }
}
