const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

module.exports = function withIosModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfilePath)) {
        return config;
      }

      const podfile = fs.readFileSync(podfilePath, 'utf8');
      if (podfile.includes('use_modular_headers!')) {
        return config;
      }

      const marker = 'prepare_react_native_project!';
      const nextPodfile = podfile.includes(marker)
        ? podfile.replace(marker, `${marker}\n\nuse_modular_headers!`)
        : `use_modular_headers!\n\n${podfile}`;

      fs.writeFileSync(podfilePath, nextPodfile);
      return config;
    },
  ]);
};
