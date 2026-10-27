# @genclass/runtime-model

The on-device model of [`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime), the open-source
browser library that reports race conditions in web apps while they happen: stale responses, duplicate requests,
inconsistent state and failure storms. The runtime runs this model with onnxruntime-web in a Web Worker, on WebGPU
or WASM. Inference happens on the user's device and the model itself sends nothing; the runtime's anonymous
diagnostics are separate (see [Privacy](#privacy)).

This page covers `@genclass/runtime-model@0.2.0` (model `genclass-runtime-r17` 2.0.0-rc4t, training run
`r17-v2dT`), the default model of `@genclass/runtime` 0.1.0-beta.1 and later, including `0.2.2` (npm `latest`) and
`0.3.0-beta.4` (`beta`, 2026-10-27). Training data, held-out results, thresholds and limits are in the
[model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md).

## At a glance

| | `@genclass/runtime-model@0.2.0` |
|---|---|
| what it does | reads what the runtime observed in your app (a *situation*) and answers typed questions about it: what is going on (`expected`, `stale`, `duplicate`, `failing`, ...) and which generic action fits |
| used by | `@genclass/runtime` 0.1.0-beta.1 and later (its default model URL) |
| size | 8.8M parameters: an ettin-encoder-17m backbone pruned to a 16,364-token vocabulary (8.1M encoder + 0.7M heads) |
| download | about 13 MB on a first visit on WASM: the 10.2 MB q8 model file, ONNX Runtime's wasm (3.07 MB brotli) and the tokenizer. On WebGPU, a 5.5 MB brotli ONNX Runtime build instead, and with `shader-f16` the 13.6 MB fp16 file instead of the q8. Once, then cached |
| memory | +190 to 280 MB renderer memory while the model is loaded, on one pilot app (runtime 0.1.0-beta.3, Playwright Chromium, 4× CPU throttling). From runtime `0.3.0` the model is not loaded on devices that report 2 GB of memory or less, nor on Save-Data connections |
| speed | 182 / 330 / 599 ms per forward pass at 500 / 780 / 1,170 tokens on one WASM thread (fitted from runs in Node, not in a browser); normal traffic makes no model calls |
| false interventions at `balanced` (guard / heal) | 0.13% / 0.59% on held-out simulated apps; 0.00% on held-out real apps |
| guard recall at `balanced` (same gate) | 7.8% of clear simulated cases, 7.5% of actionable real-app cases |
| observe detections at `balanced`, held-out real apps, right diagnosis | duplicate submits 75%, stale overwrites 30% (`situation-v2.3` slice; 21% on `situation-v2`), genuine breaks 6%. False detections were held to at most 2% (real) and 3% (simulated) of clean decisions, met on held-out test; the exact rates are not published. Runtime `0.3.0`'s observe default also records *possible* detections, down to the `eager` report gate (0.70): likely and possible together are expected at the `eager` profile's 77% / 45% / 13%, with false detections held to at most 5% (real) and 6% (simulated); the share of possible detections that are false is not measured |
| licence | Apache-2.0 (initialised from `jhu-clsp/ettin-encoder-17m`, MIT) |

Numbers: [model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md)
and [RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) §1, §2, §11 and
§17. The false-intervention rate (FIR) is the share of cases where doing nothing was best but the gate fired anyway.

## Do I need to install it?

No. `@genclass/runtime` loads the model from jsDelivr when the browser is idle after page load, caches it in Cache
Storage and checks every file's sha256. From `0.3.0` it skips the model on devices that report 2 GB of memory or
less and on Save-Data connections. This is the default model URL:

```
https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/
```

Install this package only to serve the model yourself ([Self-hosting](#self-hosting)).

## Files

`files/model.json` lists every file with its size and sha256. The runtime checks both before using a file.

| file | size | used for |
|---|---|---|
| `files/model.json` | 1 KB | the model card the runtime reads first (`genclass-runtime-model/1`) |
| `files/genclass-runtime-r17-q8.onnx` | 10.2 MB (10,160,186 bytes) | WASM, and WebGPU without `shader-f16`. 8-bit weights (block 16), int8 embeddings |
| `files/genclass-runtime-r17-fp16.onnx` | 13.6 MB (13,569,879 bytes) | WebGPU with `shader-f16` |
| `files/tokenizer.json` | 1.1 MB | byte-level BPE, 16,364 tokens |
| `files/calibration.json` | 1 KB | per-question-kind temperatures |
| `files/meta.json` | 5 KB | graph inputs and outputs, the gain-gate margins and detection thresholds per aggressiveness profile |

A browser downloads `model.json`, the tokenizer, the calibration, the meta file and **one** of the two `.onnx` files,
plus onnxruntime-web's wasm from jsDelivr's `onnxruntime-web` package. On WASM a first visit downloads about 13 MB.
A pilot app with `@genclass/runtime` 0.1.0-beta.3 and this model recorded 12.7 MB after the load event: the q8 model
at 9.45 MB as recorded, ONNX Runtime's wasm at 3.07 MB brotli and the tokenizer at 207 KB; with the q8 file at its
full 10.2 MB the same sum is about 13.4 MB
([RESULTS.md §17](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#17-browser-cost-on-a-pilot-app-2026-10-09-and-2026-10-10)).
On WebGPU the ONNX Runtime build is larger (5.5 MB brotli), and with `shader-f16` the 13.6 MB fp16 file replaces the
q8. Later visits revalidate `model.json` (about 1 KB) and read the rest from Cache Storage. A forward pass on one WASM
thread is estimated at about 182 / 330 / 599 ms at 500 / 780 / 1,170 tokens (a least-squares fit over runs of
onnxruntime-web 1.30 in Node on the training VM, not in a browser;
[RESULTS.md §2](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#2-r17-vs-r32-choosing-the-shipping-model)).

Model: `genclass-runtime-r17` 2.0.0-rc4t (training run `r17-v2dT`). `model.json` sha256
`3f79289280dc11e4284b04d63a505e3cac9e77b3dc06a981cd4686c880169daf`. Its `meta.json` gate is a gain gate with three
aggressiveness profiles (`cautious`, `balanced`, `eager`), chosen with `GenClass.init({ aggressiveness })` in
`@genclass/runtime` 0.1.0-beta.1 and later.

## Self-hosting

To serve the model yourself (offline apps, strict CSP, no third-party CDN), download it with the runtime's CLI,
which verifies every hash:

```bash
npx @genclass/runtime@beta fetch-model public/genclass-model   # model + ONNX Runtime files (into public/genclass-model/ort/)
```

```ts
GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } });
```

`fetch-model` downloads from `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/` by default
(`--from <url>` for another copy). `--ort all`, the default, copies both ONNX Runtime builds: the WASM one (14 MB) and
the WebGPU one (27 MB), which is over some static hosts' per-file limit (Cloudflare: 25 MiB); there, use `--ort wasm`
and add `device: "wasm"` to the `model` options above. `--ort none` keeps loading ONNX Runtime from jsDelivr.

Or copy the model files from this package:

```bash
npm install @genclass/runtime-model
cp -r node_modules/@genclass/runtime-model/files public/genclass-model
```

```ts
GenClass.init({ model: { baseUrl: "/genclass-model/" } });
```

This serves the model only: ONNX Runtime's wasm still loads from jsDelivr. For no third-party CDN, use `fetch-model`
above and `ortWasmPaths`.

With the script tag, use `data-model="/genclass-model/"` (and `data-ort` for a self-hosted ONNX Runtime). The full
Content-Security-Policy guidance is in the
[`@genclass/runtime` README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting).

## What it can and can't do

In short (details in the
[model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md)):

- **It rarely acts, and misses most problems.** In `guard` or `heal` mode it acts only when its expected gain over
  doing nothing clears the profile's margin and the top diagnosis is not `expected`. At the default `balanced`
  profile, guard acts on 7.8% of the clear simulated cases where acting would help, with a false-intervention rate
  of 0.13% (guard) and 0.59% (heal) on held-out simulated apps, and 0.00% on held-out real apps for every profile.
  `cautious` is 0.005% / 0.26%, with guard recall 2.4%.
- **In observe mode (the runtime's default; only 0.1.0-beta.1 defaulted to `guard`) it reports.** At `balanced` it
  detects, with the right diagnosis, about 75% of duplicate submits, 30% of stale overwrites and 6% of genuine breaks
  on held-out real apps. The 0.2.0 fit held false detections to at most 2% of clean real-app decisions and 3% of
  simulated ones; the exact rates were not published. From runtime `0.3.0`, observe by default also records
  *possible* detections (probability from the `eager` report value, 0.70, up to the report gate) on `console.debug`,
  in the devtools and in telemetry (on the app's own listeners only with `detect: "possible"`). Likely and possible
  together are expected to match the `eager` profile: 77% / 45% / 13% detected, false detections held to at most 5%
  (real) and 6% (simulated); the share of possible detections that are false is not measured, and neither tier has
  been measured end to end on 0.3.0 ([RESULTS.md §11](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#11-observe-mode-detection-in-030-the-possible-tier-and-deferred-situations)).
  The previous model (0.1.0, report threshold 0.85) had 0.36% on clean or benign real-app traffic and
  3.8% of held-out real-app decisions whose correct diagnosis was `expected` (most of them from one app).
- **Calibration** (ECE) has not been measured for 0.2.0 (0.1.0: 0.021 to 0.023).
- It never sees your source code, only the situation text the runtime builds. It is a small encoder, not a general
  reasoner.

## Privacy

The model runs inside the page and sends nothing. `@genclass/runtime`, which loads it, sends **anonymous diagnostics
by default** on public hosts: GenClass's decisions and counts, no text from your page unless the app opts in, to the
GenClass maintainers to improve the model. They are off on `localhost` and other local hosts from `0.2.2`. Earlier
versions differ: `0.1.0-beta.1` and `0.1.0-beta.2` have no diagnostics, `0.1.0-beta.3` to `0.2.1` send from local
hosts too, and `0.1.0-beta.3` to `0.2.0` include the redacted situation text the model read by default. Opt out with
`GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`, `localStorage.setItem("genclass.telemetry", "off")`
or `init --no-telemetry`; browsers sending Global Privacy Control are never collected.
Details: [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

## License

Apache-2.0. Initialised from `jhu-clsp/ettin-encoder-17m` (MIT); trained only on data generated for this project
(see the [model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md)).

<!-- Maintainers: npmjs.com shows the README and package.json fields (description, keywords, homepage) of the
published version, MODEL_CARD.md ships in the same tarball, and a published version cannot be republished. On
2026-10-22 npm has 0.2.0, published 2026-10-08 with an older README and description; release.yml publishes only
@genclass/runtime. Edits here reach npm only with a new version of this package (same model files), which is the
owner's decision. -->
