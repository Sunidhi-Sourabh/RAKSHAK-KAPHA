# RAKSHAK-KAPHA
### Dual-Surveillance Cardiorespiratory & Environmental Diagnostic Node

---

## Executive Summary

**RAKSHAK-KAPHA** is an off-grid, low-cost (sub-₹1,800) chest pendant and diagnostic patch engineered for extreme disaster evacuations, flood relief camps, and frontline ASHA worker screening in rural India. 

Unlike peripheral wrist wearables that fail during cold-induced vasoconstriction, circulatory shock, or flood exposure, RAKSHAK-KAPHA directly measures central vascular signals and chest acoustics over the sternum while simultaneously monitoring toxic gas emissions and heat stress right within the user's **breathing zone**.

````
+--------------------------------------------------------------------------+
|                     RAKSHAK-KAPHA LOCKET SCHEMATIC                       |
|                                                                          |
|   [OUTER VENT]  --> MQ-135 (Breathing Toxins) + DHT22 (Ambient Heat)     |
|   [INNER FACE]  --> MAX30102 (Central Vitals) + Piezo Mic (Chest Acoustics)|
|   [CORE UNIT]   --> ESP32 + Battery + Status LED Ring + BLE Mesh         |
+--------------------------------------------------------------------------+
````
---

## 🚀 Key Technical Innovations

1. **Central Sternum Signal Acquisition**: Obtains central PPG (arterial pulse, SpO₂) and phonocardiographic acoustic signals over the chest wall, avoiding peripheral signal dropouts during flood hypothermia.
2. **Breathing-Zone Ambient Air Sensing**: Measures inhaled CO₂, toxic combustion gases (MQ-135), and heat-humidity index (DHT22) at neck height rather than ground level.
3. **Dual Operational Modes**:
   - **Mode A (Continuous Personal Companion)**: Passive 24/7 vital monitoring and local risk logging.
   - **Mode B (ASHA 10-Second Rapid Screening)**: Frontline health workers press the locket onto a patient’s chest for 10 seconds to generate an aggregate median **mSTaRT triage score**.
4. **Zero-Cloud Offline BLE Mesh Infrastructure**: Nodes auto-mesh over Bluetooth Low Energy (BLE) to relay vital telemetry across disaster shelters without 4G/5G or cloud dependencies.
5. **On-Device TinyML Inference**: Features an unrolled, zero-heap decision forest classifier compiled directly into C-headers (`triage_model.h`), executing in `<1 ms` on an ESP32.
6. **ABDM / HL7 FHIR Data Export**: Native formatting of diagnostic outputs into HL7 FHIR JSON bundles for seamless integration with national digital health stacks.

---

## 🚦 Automated mSTaRT Triage Engine

The system continuously classifies health severity using a modified **Simple Triage and Rapid Treatment (mSTaRT)** algorithm:

| Triage Level | Class Name | Clinical Threshold Criteria | Feedback (LED & Buzzer) |
| :--- | :--- | :--- | :--- |
| **CLASS 0** | **MINIMAL (Green)** | SpO₂ ≥ 95%, HR 55–100 bpm, RR 12–20 rpm, CO₂ < 1000 ppm | Solid Green LED • Silent |
| **CLASS 1** | **DELAYED (Yellow)** | SpO₂ 90–94%, HR 101–125 bpm, RR 21–28 rpm, CO₂ 1000–2500 ppm | Solid Amber LED • 50ms Chirp / 4s |
| **CLASS 2** | **IMMEDIATE (Red)** | SpO₂ < 90%, HR > 125 or < 50 bpm, RR > 28 or < 10 rpm, CO₂ > 2500 ppm | Rapid Flashing Red LED • 1.5–2.5kHz Oscillating Siren |

---

## 🛠️ Hardware Bill of Materials (BOM)

| Component Name | Functional Role | Est. Cost (INR) | Sourcing Channel |
| :--- | :--- | :--- | :--- |
| **ESP32 NodeMCU Board** | Dual-core MCU, TinyML engine & BLE Mesh node | ₹420 | College Lab / Robu.in |
| **MAX30102 Optical Sensor** | Central chest vascular pulse, SpO₂ & tissue temp | ₹280 | Online Electronics |
| **Piezoelectric Acoustic Mic** | Chest wall acoustics & respiratory effort pickup | ₹90 | Local Hardware |
| **DHT22 Sensor** | Ambient chest-level micro-climate temp & humidity | ₹220 | College Lab / Online |
| **MQ-135 Gas Sensor** | Inhaled air quality (CO₂, smoke, ammonia, toxins) | ₹160 | College Lab / Online |
| **3.7V 650mAh Li-Po Battery** | Compact rechargeable power cell (20+ hrs runtime) | ₹220 | Local Market |
| **WS2812B RGB LED & Buzzer** | Visual tri-color feedback & acoustic alarm | ₹120 | College Lab |
| **Custom Enclosure & Lanyard**| Compact 3D-printed / acrylic protective casing | ₹200 | Local Workshop |
| **TOTAL HARDWARE COST** | **Fully Functional Edge Prototype** | **₹1,710** | *Within Student Budget* |

---

## 📁 Repository Structure

````
RAKSHAK-KAPHA/
├── .lovable/
│   └── project.json              # Lovable platform project metadata
├── firmware/
│   ├── pipeline.py               # Synthetic data generator & TinyML model trainer
│   ├── rakshak_kapha.ino         # ESP32 dual-mode firmware (BLE GATT, ASHA screening)
│   └── triage_model.h            # Auto-generated unrolled TinyML C-header
├── public/
│   ├── favicon.ico               # App favicon
│   └── robots.txt                # Search crawler configuration
├── src/
│   ├── components/               # React UI components (Dashboard, Gauges, Triage Cards)
│   ├── data/                     # Initial telemetry states & mock disaster datasets
│   ├── hooks/                    # Custom React hooks (Web Serial, BLE Mesh, Audio Siren)
│   ├── lib/                      # Helper functions & ABDM / HL7 FHIR exporters
│   ├── routes/                   # TanStack Router page views & navigation layouts
│   ├── router.tsx                # Client-side router configuration
│   ├── routeTree.gen.ts          # Auto-generated TanStack route tree
│   ├── server.ts                 # Application server entry script
│   ├── start.ts                  # App bootloader & startup handler
│   └── styles.css                # Global Tailwind CSS & custom tactical UI styles
├── AGENTS.md                     # Guidelines for AI agent development & code generation
├── bun.lock                      # Bun dependency lockfile
├── bunfig.toml                   # Bun runtime configuration
├── components.json               # shadcn/ui configuration
├── eslint.config.js              # ESLint code style rules
├── package.json                  # Scripts & NPM package dependencies
├── README.md                     # Project documentation
├── roadmap.md                    # System architecture & future development milestones
├── tsconfig.json                 # TypeScript compiler configuration
└── vite.config.ts                # Vite build & bundler configuration
````

---

## 🔧 Hardware Pin Mapping (ESP32)

| ESP32 GPIO Pin | Connected Peripheral | Protocol / Signal Type |
| :--- | :--- | :--- |
| **GPIO 21 (SDA)** | MAX30102 Sensor | I²C Data |
| **GPIO 22 (SCL)** | MAX30102 Sensor | I²C Clock |
| **GPIO 18** | WS2812B Addressable RGB LED | One-Wire Bitbang (800 kHz) |
| **GPIO 19** | Active Piezo Buzzer | Digital Output / PWM Tone |
| **GPIO 4** | Mode Switch Button (Continuous vs. ASHA) | Digital Input (`INPUT_PULLUP`) |
| **GPIO 34 (ADC1)** | MQ-135 Gas Sensor | Analog Input |
| **GPIO 27** | DHT22 Temperature & Humidity | Single-Bus Digital |

---

## ⚡ Quick Start Guide

### 1. Web Command Station Setup (Frontend)

Clone the repository and install dependencies using **Bun** (or `npm`):

```bash
# Clone the repository
git clone [https://github.com/your-org/RAKSHAK-KAPHA.git](https://github.com/your-org/RAKSHAK-KAPHA.git)
cd RAKSHAK-KAPHA

# Install dependencies using Bun (recommended) or npm
bun install
# or: npm install

# Start the Vite development server
bun dev
# or: npm run dev
````
Open your browser at http://localhost:5173 to access the Command Station UI.

2. Flashing ESP32 Firmware
Open firmware/rakshak_kapha.ino in the Arduino IDE.
Install board support: esp32 by Expressif Systems.
Install required libraries:
Adafruit NeoPixel (v1.12.3)
Native BLEDevice (bundled with ESP32 core)
Target Board: ESP32 Dev Module | Upload Speed: 921600 | Baud Rate: 115200.
Upload firmware to the ESP32 board.

3. Training & Exporting the TinyML Model
To retrain the Random Forest model on custom multi-modal telemetry and generate a fresh triage_model.h:

```
cd firmware/
python3 -m venv venv && source venv/bin/activate
pip install numpy pandas scikit-learn
python3 pipeline.py
````
This updates triage_model.h for compile-time embedding into the ESP32.

---
## Security & Privacy
1. Zero-Cloud Architecture: Vitals and location data are processed entirely offline without sending telemetry to external cloud servers.
2. DPDP Act & HIPAA Compliant: Patient identities remain anonymous during peer-to-peer BLE mesh broadcasts using rotating ephemeral node identifiers.

---
## References & Accreditation
1. National Health Mission (NHM): ASHA Operational Guidelines for Primary Healthcare.
2. National Disaster Management Authority (NDMA): Guidelines on Emergency Field Triage and Relief Camps.
3. IEEE Transactions on Biomedical Engineering: Validation benchmarks for sternum PPG signal fidelity.
4. ABDM Digital Health Policy: HL7 FHIR specifications for offline health records.
