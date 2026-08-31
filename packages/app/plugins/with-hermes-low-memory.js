const { withAppBuildGradle } = require("expo/config-plugins");

// Drops hermesc's default "-O" optimization flag (keeping only
// "-output-source-map"). "-O" makes hermesc's memory usage scale sharply
// with bundle size; on EAS's free-tier 4vCPU/15.62GB workers this app's
// ~5850-module bundle gets hermesc OOM-killed (exit 137) during
// createBundleReleaseJsAndAssets even with a single-ABI native build.
// Trades a larger, slightly slower-at-runtime bytecode bundle for a build
// that actually completes. Only used for the internal hydra-apk test
// profile, never for the real production build.
function withHermesLowMemory(config) {
  return withAppBuildGradle(config, (modConfig) => {
    const injectedLine = 'hermesFlags = ["-output-source-map"]';
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
