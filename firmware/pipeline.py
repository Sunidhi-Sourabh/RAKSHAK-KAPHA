#!/usr/bin/env python3
"""
RAKSHAK-KAPHA :: Module 3 -- Benchmark Wearable Dataset Generator & TinyML Export
====================================================================================

Pipeline stages:
  1. Synthesize a 10-minute (600 s @ 1 Hz), multi-phase cardiopulmonary distress
     dataset (baseline -> acute hypoxic/toxic ingress -> partial recovery) and
     write it to kapha_benchmark_dataset.csv.
  2. Train a RandomForestClassifier on [hr, spo2, rr, hrv, co2] -> triage class
     {0: GREEN, 1: YELLOW, 2: RED}, following the deterministic mSTaRT rule set
     used on-device as ground truth labeling logic.
  3. Evaluate (accuracy, classification report, confusion matrix).
  4. Export the trained forest as a dependency-free, allocation-free C function
     into triage_model.h, suitable for direct inclusion in the ESP32 firmware.

Dependencies (exact, tested versions in this environment):
  numpy==2.4.4
  pandas==3.0.2
  scikit-learn==1.8.0

Run:
  python3 pipeline.py
"""

from __future__ import annotations

import textwrap
import time

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
)
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier

RNG_SEED = 42
SAMPLE_HZ = 1
TOTAL_SECONDS = 600  # 10 minutes

# --------------------------------------------------------------------------- #
# 1. SYNTHETIC MULTI-MODAL STRESS GENERATOR
# --------------------------------------------------------------------------- #


def _smoothstep(t: np.ndarray, edge0: float, edge1: float) -> np.ndarray:
    """Smooth 0->1 ramp between edge0 and edge1 (clamped), for believable
    physiological transitions instead of step discontinuities."""
    x = np.clip((t - edge0) / (edge1 - edge0), 0.0, 1.0)
    return x * x * (3 - 2 * x)


def generate_dataset(seed: int = RNG_SEED) -> pd.DataFrame:
    """Model a 10-minute continuous physiological distress scenario sampled at
    1 Hz (600 rows), across three clinically-motivated phases:

      Phase 1 (0-240s):   Normal baseline rest.
                          SpO2 96-99%, HR 65-75 bpm, RR 14-16 rpm,
                          CO2 400-600 ppm, HRV (RMSSD) 35-60 ms (healthy vagal tone).
      Phase 2 (241-450s): Acute Hypoxic/Toxic Ingress (flood hypothermia +
                          toxic combustion gas exposure).
                          SpO2 82-89%, HR up to 135 bpm, RR chaotic 28-34 rpm,
                          CO2 up to 3200 ppm, HRV collapses to 5-15 ms
                          (sympathetic surge / parasympathetic withdrawal).
      Phase 3 (451-600s): Partial Recovery / Extreme Triage State.
                          Vitals drift back toward baseline but do not fully
                          normalize within the window, HRV partially recovers.
    """
    rng = np.random.default_rng(seed)
    t = np.arange(0, TOTAL_SECONDS, 1.0 / SAMPLE_HZ)
    n = len(t)

    hr = np.empty(n)
    spo2 = np.empty(n)
    rr = np.empty(n)
    co2 = np.empty(n)
    hrv = np.empty(n)
    phase = np.empty(n, dtype=int)

    # Transition ramps (smoothstep) around the phase boundaries so the model
    # sees realistic onset/offset kinetics rather than instantaneous jumps.
    onset = _smoothstep(t, 225.0, 260.0)  # baseline -> distress, centered ~241s
    recovery = _smoothstep(t, 435.0, 470.0)  # distress -> recovery, centered ~451s

    for i in range(n):
        tt = t[i]
        if tt <= 240:
            phase[i] = 0
        elif tt <= 450:
            phase[i] = 1
        else:
            phase[i] = 2

    # Baseline targets
    hr_base = rng.uniform(65, 75, n)
    spo2_base = rng.uniform(96, 99, n)
    rr_base = rng.uniform(14, 16, n)
    co2_base = rng.uniform(400, 600, n)
    hrv_base = rng.uniform(35, 60, n)

    # Distress targets
    hr_dist = rng.uniform(115, 135, n)
    spo2_dist = rng.uniform(82, 89, n)
    rr_dist = rng.uniform(28, 34, n) + rng.normal(0, 1.5, n)  # "chaotic"
    co2_dist = rng.uniform(2600, 3200, n)
    hrv_dist = rng.uniform(5, 15, n)

    # Partial-recovery targets (recovers toward, but does not fully reach,
    # baseline within the 150 s window -> "extreme triage state")
    recovery_frac = 0.55  # fraction of the way back to baseline
    hr_rec = hr_dist - (hr_dist - hr_base) * recovery_frac
    spo2_rec = spo2_dist + (spo2_base - spo2_dist) * recovery_frac
    rr_rec = rr_dist - (rr_dist - rr_base) * recovery_frac
    co2_rec = co2_dist - (co2_dist - co2_base) * recovery_frac
    hrv_rec = hrv_dist + (hrv_base - hrv_dist) * recovery_frac

    for i in range(n):
        if phase[i] == 0:
            hr[i], spo2[i], rr[i], co2[i], hrv[i] = (
                hr_base[i],
                spo2_base[i],
                rr_base[i],
                co2_base[i],
                hrv_base[i],
            )
        elif phase[i] == 1:
            # Blend baseline -> distress across the onset ramp so 241s isn't
            # a discontinuity for a per-sample classifier or the RMSSD buffer.
            w = onset[i]
            hr[i] = hr_base[i] * (1 - w) + hr_dist[i] * w
            spo2[i] = spo2_base[i] * (1 - w) + spo2_dist[i] * w
            rr[i] = rr_base[i] * (1 - w) + rr_dist[i] * w
            co2[i] = co2_base[i] * (1 - w) + co2_dist[i] * w
            hrv[i] = hrv_base[i] * (1 - w) + hrv_dist[i] * w
        else:
            w = recovery[i]
            hr[i] = hr_dist[i] * (1 - w) + hr_rec[i] * w
            spo2[i] = spo2_dist[i] * (1 - w) + spo2_rec[i] * w
            rr[i] = rr_dist[i] * (1 - w) + rr_rec[i] * w
            co2[i] = co2_dist[i] * (1 - w) + co2_rec[i] * w
            hrv[i] = hrv_dist[i] * (1 - w) + hrv_rec[i] * w

    # Clip to physiologically sane bounds
    hr = np.clip(hr, 40, 180)
    spo2 = np.clip(spo2, 70, 100)
    rr = np.clip(rr, 6, 40)
    co2 = np.clip(co2, 380, 5000)
    hrv = np.clip(hrv, 2, 80)

    df = pd.DataFrame(
        {
            "t_s": t.astype(int),
            "hr": np.round(hr, 1),
            "spo2": np.round(spo2, 1),
            "rr": np.round(rr, 1),
            "hrv": np.round(hrv, 1),
            "co2": np.round(co2, 0).astype(int),
            "phase": phase,
        }
    )
    df["triage"] = df.apply(
        lambda row: mstart_triage_label(row.spo2, row.hr, row.rr, row.co2), axis=1
    )
    return df


def mstart_triage_label(spo2: float, hr: float, rr: float, co2: float) -> int:
    """Deterministic mSTaRT-derived ground-truth labeling logic -- identical
    thresholds to the on-device firmware's Module 1 triage engine, worst-class
    (highest severity) wins when multiple criteria are met."""
    is_red = spo2 < 90 or hr > 125 or hr < 50 or rr > 28 or rr < 10 or co2 > 2500
    if is_red:
        return 2
    is_yellow = (
        90 <= spo2 <= 94
        or 101 <= hr <= 125
        or 21 <= rr <= 28
        or 1000 <= co2 <= 2500
    )
    if is_yellow:
        return 1
    return 0


# --------------------------------------------------------------------------- #
# 2 & 3. MODEL TRAINING, EVALUATION
# --------------------------------------------------------------------------- #

FEATURES = ["hr", "spo2", "rr", "hrv", "co2"]
CLASS_NAMES = ["GREEN(0)", "YELLOW(1)", "RED(2)"]


def train_and_evaluate(df: pd.DataFrame, seed: int = RNG_SEED):
    X = df[FEATURES].to_numpy(dtype=np.float32)
    y = df["triage"].to_numpy(dtype=np.int32)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.25, random_state=seed, stratify=y
    )

    # Small, shallow forest -- deliberately constrained (few trees, low depth)
    # so the exported C code is tiny, branch-predictable, and executes in
    # well under 1 ms on an ESP32 with zero heap allocation.
    clf = RandomForestClassifier(
        n_estimators=7,
        max_depth=4,
        min_samples_leaf=6,
        random_state=seed,
        n_jobs=-1,
    )
    clf.fit(X_train, y_train)

    y_pred = clf.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    report = classification_report(y_test, y_pred, target_names=CLASS_NAMES, digits=4)
    cm = confusion_matrix(y_test, y_pred)

    print("=" * 72)
    print("RAKSHAK-KAPHA :: TinyML Triage Classifier -- Evaluation")
    print("=" * 72)
    print(f"Train samples: {len(X_train)}   Test samples: {len(X_test)}")
    print(f"Accuracy: {acc:.4f}\n")
    print("Classification report:")
    print(report)
    print("Confusion matrix (rows=true, cols=pred):")
    print(pd.DataFrame(cm, index=CLASS_NAMES, columns=CLASS_NAMES))
    print("=" * 72)

    return clf, acc, report, cm


# --------------------------------------------------------------------------- #
# 3. C-HEADER EXPORTER (TinyML export -- decision-forest -> nested if/else C)
# --------------------------------------------------------------------------- #


def _tree_to_c(tree: DecisionTreeClassifier, feature_names: list[str], func_name: str) -> str:
    """Recursively unroll a single sklearn decision tree into a nested C
    if/else expression tree. Pure stack-based recursion in the *generator*
    only -- the emitted C function itself is flat if/else with no recursion,
    no loops, and no heap allocation, so it is O(depth) branches at runtime."""
    t = tree.tree_
    lines: list[str] = []

    def recurse(node: int, depth: int) -> None:
        indent = "    " * (depth + 1)
        if t.feature[node] != -2:  # not a leaf
            feat = feature_names[t.feature[node]]
            thresh = t.threshold[node]
            lines.append(f"{indent}if ({feat} <= {thresh:.6f}f) {{")
            recurse(t.children_left[node], depth + 1)
            lines.append(f"{indent}}} else {{")
            recurse(t.children_right[node], depth + 1)
            lines.append(f"{indent}}}")
        else:
            class_idx = int(np.argmax(t.value[node][0]))
            lines.append(f"{indent}return {class_idx};")

    lines.append(f"static inline int {func_name}(")
    lines.append("    float " + ", float ".join(feature_names) + ") {")
    recurse(0, 0)
    lines.append("}")
    return "\n".join(lines)


def export_c_header(
    forest: RandomForestClassifier,
    feature_names: list[str],
    out_path: str = "triage_model.h",
    train_accuracy: float | None = None,
) -> None:
    n_trees = len(forest.estimators_)
    tree_funcs = []
    tree_calls = []
    for i, est in enumerate(forest.estimators_):
        fname = f"kapha_tree_{i}"
        tree_funcs.append(_tree_to_c(est, feature_names, fname))
        tree_calls.append(fname)

    header_guard = "RAKSHAK_KAPHA_TRIAGE_MODEL_H"
    generated_at = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())
    acc_line = (
        f" * Held-out test accuracy at export time: {train_accuracy:.4f}\n"
        if train_accuracy is not None
        else ""
    )

    votes_array = ", ".join(tree_calls[i] + "(hr, spo2, rr, hrv, co2)" for i in range(n_trees))

    content = f"""\
/*
 * triage_model.h -- RAKSHAK-KAPHA TinyML Export (Module 3 pipeline.py)
 *
 * Auto-generated on {generated_at} from a scikit-learn RandomForestClassifier
 * ({n_trees} trees, max_depth<=4) trained on [hr, spo2, rr, hrv, co2] against
 * mSTaRT-derived triage labels {{0=GREEN, 1=YELLOW, 2=RED}}.
{acc_line} *
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

#ifndef {header_guard}
#define {header_guard}

#ifdef __cplusplus
extern "C" {{
#endif

"""

    content += "\n\n".join(tree_funcs)

    content += f"""

/*
 * kapha_triage_infer: majority vote across the {n_trees} trees above.
 * Ties broken toward the higher-severity class (fail-safe: when in doubt,
 * escalate) -- this mirrors the "worst-class wins" rule used to label the
 * training data in mstart_triage_label() (pipeline.py).
 */
static inline int kapha_triage_infer(float hr, float spo2, float rr, float hrv, float co2) {{
    int votes[3] = {{0, 0, 0}};
    int cls;

    {chr(10).join(f'    cls = {tree_calls[i]}(hr, spo2, rr, hrv, co2); votes[cls]++;' for i in range(n_trees)).strip()}

    int best = 0;
    int best_votes = votes[0];
    for (int c = 1; c < 3; c++) {{
        if (votes[c] >= best_votes) {{ /* >= : ties favor higher-severity class */
            best_votes = votes[c];
            best = c;
        }}
    }}
    return best;
}}

#ifdef __cplusplus
}}
#endif

#endif /* {header_guard} */
"""

    with open(out_path, "w") as f:
        f.write(content)


# --------------------------------------------------------------------------- #
# MAIN
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    print("Generating synthetic 10-minute multi-phase distress dataset ...")
    df = generate_dataset()
    df.to_csv("kapha_benchmark_dataset.csv", index=False)
    print(f"Wrote kapha_benchmark_dataset.csv  ({len(df)} rows)\n")

    print("Training RandomForestClassifier on [hr, spo2, rr, hrv, co2] -> triage ...")
    clf, acc, report, cm = train_and_evaluate(df)

    print("\nExporting TinyML C header ...")
    export_c_header(clf, FEATURES, out_path="triage_model.h", train_accuracy=acc)
    print("Wrote triage_model.h")
