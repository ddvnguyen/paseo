const { withAppBuildGradle } = require("expo/config-plugins");

// Drops both of hermesc's default flags: "-O" (expensive optimizations)
// and "-output-source-map" (keeping source positions in memory during
// compilation). Both make hermesc's memory usage scale with bundle size;
// on EAS's free-tier 4vCPU/15.62GB workers this app's ~5850-module bundle
// still gets hermesc OOM-killed (exit 137) during createBundleReleaseJsAndAssets
// even with a single-ABI native build and a shrunk Gradle heap. Trades a
// larger, slightly slower-at-runtime, unmapped-stacktrace bytecode bundle
// for a build that actually completes. Only used for the internal
// hydra-apk test profile, never for the real production build.
function withHermesLowMemory(config) {
  return withAppBuildGradle(config, (modConfig) => {
    const injectedLine = "hermesFlags = []";
    if (modConfig.modResults.contents.includes(injectedLine)) {
      return modConfig;
    }

    const reactBlockOpen = "react {";
    if (!modConfig.modResults.contents.includes(reactBlockOpen)) {
      throw new Error(
        "Could not set low-memory hermesFlags: no react { } block in app/build.gradle",
      );
    }

    modConfig.modResults.contents = modConfig.modResults.contents.replace(
      reactBlockOpen,
      `${reactBlockOpen}\n    ${injectedLine}`,
    );
    return modConfig;
  });
}

module.exports = withHermesLowMemory;
