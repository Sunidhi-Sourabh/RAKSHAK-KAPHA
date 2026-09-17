# RAKSHAK-KAPHA prototype

- [x] Tactical design system (instrument-panel dark, triage signal colors)
- [x] Incident Commander dashboard: metric cards, dual 60 s oscilloscopes, triage banner
- [x] Hardware digital twin: NeoPixel ring, buzzer emulator, ASHA mode button
- [x] 3-way ingestion: dataset replay, Web Serial (115200), Web Bluetooth (0x180D)
- [x] One-click ABDM / HL7 FHIR R4 Bundle export
- [x] Exact port of uploaded triage_model.h + real kapha_benchmark_dataset.csv replay
- [x] CO2 in ppm matching dataset units; ground-truth agreement readout
- [x] Phase seek controls (baseline / acute / recovery) and µs inference timing
- Source deliverables kept in firmware/: rakshak_kapha.ino, triage_model.h, pipeline.py
