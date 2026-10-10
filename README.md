# npm services

- `services/npm-package-services-section` holds operations on an npm package.
- `services/npm-package-set-services-section` holds operations on finite package
  selections without implying workspace, dependency, registry, or ecosystem
  relations.
- `services/npm-package-set-services-section/services/npm-package-set-information-reading-service/scripts/read-npm-package-info.mjs`
  reads selected manifest fields across one or more directory trees.
- `services/npm-package-services-section/services/project-npm-package-lock-regeneration-command-service/scripts/project-npm-package-lock-regeneration-command.mjs`
  purely projects an explicit directory and execution policy to the exact
  shell-free command which regenerates `package-lock.json`.
- `services/npm-package-services-section/services/apply-npm-package-lock-regeneration-command-service/scripts/apply-npm-package-lock-regeneration-command.mjs`
  applies that command and returns its execution receipt.
