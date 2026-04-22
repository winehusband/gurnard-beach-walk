# Gurnard Beach Walk — Calibration Data

## Real-World Observations

| Date | Time (BST) | User Rating | Notes |
|------|-----------|-------------|-------|
| Tue 14 Apr 2026 | 14:45 | 5.0 | Perfect walk, massive beach, really long walk possible |
| Wed 16 Apr 2026 | 12:47 | 1.5 | Only 3-5 metres of beach at widest, can't walk far |
| Thu 17 Apr 2026 | 15:26 | 2.5 | Tide falling but can't get past inlet/headland |
| Thu 17 Apr 2026 | 15:40 | 3.0 | Inlet just passable in shoes |
| Thu 17 Apr 2026 | ~15:58 | 4.5 | Good beach, well past inlet |
| Sat 18 Apr 2026 | 16:55 | 4.7 | Long walk possible, app showed 4.1 (model was too conservative) |
| Sun 20 Apr 2026 | 15:54 | 1.25 | Almost no beach, app showed 1.9 (model too optimistic near HW) |
| Tue 22 Apr 2026 | 08:08 | 5.0 | Long walk, app showed 3.6 — spring-neap drift caused model to be ~85 min late |

## Key Thresholds

- **Inlet threshold: ~2.1m** — Below this height, the inlet between the sailing club and Gurnard Luck becomes passable and the full walk opens up
- **No beach: ~3.8m+** — At high water, no beach at all (0 stars)
- **Perfect walk: ~1.55m and below** — Enough beach for the full walk at maximum quality (5 stars)

## Tide Reference Data (thebeachguide.co.uk)

### Friday 17 April 2026
- Low: 05:04am (0.68m)
- High: 12:06pm (4.26m)
- Low: 05:23pm (0.57m)

### Saturday 18 April 2026
- High: 12:05am (4.39m)
- Low: 05:46am (0.55m)
- High: 12:26pm (4.32m)
- Low: 06:07pm (0.53m)

### Sunday 19 April 2026
- High: 12:46am (4.4m)
- Low: 06:30am (0.51m)
- High: 01:11pm (4.32m)
- Low: 06:52pm (0.59m)

### Monday 20 April 2026
- High: 01:33am (4.35m)
- Low: 07:16am (0.58m)
- High: 02:03pm (4.27m)
- Low: 07:39pm (0.74m)

## Model Calibration History

### v1 (initial build)
- Harmonic model with 7 constituents, phases estimated
- Result: timing ~1.5-2 hours early

### v2 (phase recalibration)
- REF_MS shifted +90 minutes (08:54 UTC → 10:24 UTC)
- Result: timing within ~8 minutes of real tide data

### v3 (rating curve with inlet threshold)
- Step-change at 2.1m inlet threshold
- Direction-aware verdicts (safety warnings on rising tide)
- All 4 calibration points within ~0.1 stars

### v4 (lower zone recalibration)
- Raised LOW cutoff from 1.2m to 1.55m (5-star threshold)
- New data point: Sat 18 Apr 16:55 at 1.628m → 4.7 stars (was showing 4.1)
- Change: linear lower zone now steeper (shorter 2.15→1.55m range vs 2.15→1.2m)
- All 5 calibration points within ~0.15 stars

### v5 (spring-neap phase recalibration)
- New data point: Tue 22 Apr 08:08 BST → 5 stars but app showed 3.6 (model ~85 min late)
- Root cause: S2 (solar semidiurnal) phase was wrong, causing timing drift over the spring-neap cycle
- Fix: REF_MS shifted -20 min (10:24 → 10:04 UTC) + S2 phase changed from -12° to -64°
- All 8 calibration points within ±0.46 stars (most within ±0.22)
