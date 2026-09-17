/*
 * triage_model.h -- RAKSHAK-KAPHA TinyML Export (Module 3 pipeline.py)
 *
 * Auto-generated on 2026-09-13 16:01:44 UTC from a scikit-learn RandomForestClassifier
 * (7 trees, max_depth<=4) trained on [hr, spo2, rr, hrv, co2] against
 * mSTaRT-derived triage labels {0=GREEN, 1=YELLOW, 2=RED}.
 * Held-out test accuracy at export time: 1.0000
 *
 * CONSTRAINTS SATISFIED:
 *   - Zero dynamic memory allocation (no malloc/new anywhere in this file).
 *   - No heap, no recursion, no loops at runtime: every tree is a fixed,
 *     fully-unrolled if/else ladder of depth <= 4.
 *   - Pure integer/float arithmetic, no external dependencies.
 *   - Designed to execute in well under 1 ms on an ESP32 (Xtensa LX6 @ 240 MHz).
 *
 * Usage from firmware (Module 1):
 *   #include "triage_model.h"
 *   int triageClass = kapha_triage_infer(hr, spo2, rr, hrv, co2); // 0/1/2
 */

#ifndef RAKSHAK_KAPHA_TRIAGE_MODEL_H
#define RAKSHAK_KAPHA_TRIAGE_MODEL_H

#ifdef __cplusplus
extern "C" {
#endif

static inline int kapha_tree_0(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (rr <= 18.000000f) {
        return 0;
    } else {
        if (spo2 <= 89.950001f) {
            return 2;
        } else {
            return 1;
        }
    }
}

static inline int kapha_tree_1(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (spo2 <= 94.950001f) {
        if (hrv <= 21.599999f) {
            return 2;
        } else {
            if (co2 <= 1768.500000f) {
                if (rr <= 22.500000f) {
                    return 1;
                } else {
                    return 1;
                }
            } else {
                return 1;
            }
        }
    } else {
        return 0;
    }
}

static inline int kapha_tree_2(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (hr <= 81.350002f) {
        return 0;
    } else {
        if (spo2 <= 89.799999f) {
            return 2;
        } else {
            return 1;
        }
    }
}

static inline int kapha_tree_3(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (hr <= 81.400002f) {
        return 0;
    } else {
        if (spo2 <= 90.100002f) {
            return 2;
        } else {
            return 1;
        }
    }
}

static inline int kapha_tree_4(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (rr <= 17.950000f) {
        return 0;
    } else {
        if (spo2 <= 90.000000f) {
            return 2;
        } else {
            return 1;
        }
    }
}

static inline int kapha_tree_5(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (hr <= 81.350002f) {
        return 0;
    } else {
        if (co2 <= 1986.000000f) {
            if (co2 <= 1704.000000f) {
                return 1;
            } else {
                return 1;
            }
        } else {
            if (hrv <= 18.750000f) {
                return 2;
            } else {
                return 2;
            }
        }
    }
}

static inline int kapha_tree_6(
    float hr, float spo2, float rr, float hrv, float co2) {
    if (spo2 <= 89.950001f) {
        return 2;
    } else {
        if (co2 <= 1009.000000f) {
            return 0;
        } else {
            return 1;
        }
    }
}

/*
 * kapha_triage_infer: majority vote across the 7 trees above.
 * Ties broken toward the higher-severity class (fail-safe: when in doubt,
 * escalate) -- this mirrors the "worst-class wins" rule used to label the
 * training data in mstart_triage_label() (pipeline.py).
 */
static inline int kapha_triage_infer(float hr, float spo2, float rr, float hrv, float co2) {
    int votes[3] = {0, 0, 0};
    int cls;

    cls = kapha_tree_0(hr, spo2, rr, hrv, co2); votes[cls]++;
    cls = kapha_tree_1(hr, spo2, rr, hrv, co2); votes[cls]++;
    cls = kapha_tree_2(hr, spo2, rr, hrv, co2); votes[cls]++;
    cls = kapha_tree_3(hr, spo2, rr, hrv, co2); votes[cls]++;
    cls = kapha_tree_4(hr, spo2, rr, hrv, co2); votes[cls]++;
    cls = kapha_tree_5(hr, spo2, rr, hrv, co2); votes[cls]++;
    cls = kapha_tree_6(hr, spo2, rr, hrv, co2); votes[cls]++;

    int best = 0;
    int best_votes = votes[0];
    for (int c = 1; c < 3; c++) {
        if (votes[c] >= best_votes) { /* >= : ties favor higher-severity class */
            best_votes = votes[c];
            best = c;
        }
    }
    return best;
}

#ifdef __cplusplus
}
#endif

#endif /* RAKSHAK_KAPHA_TRIAGE_MODEL_H */
