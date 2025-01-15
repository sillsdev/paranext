/** Builds white-label application */

import path from 'path';
import * as fs from 'fs/promises';
import json5 from 'json5';
import { rimraf } from 'rimraf';
import { fileURLToPath } from 'url';
import {
  ADDITIONAL_EXTENSIONS_FOLDER,
  BUILT_FILES_DESTINATION_FOLDER,
  execCommand,
  npmCiAllReposSafe,
} from './build.util';
import productInfo, {
  CORE_REPO_INFO,
  MULTI_EXTENSION_REPOS_INFO,
  TEMP_BUILD_FOLDER,
} from './product-info.data';
import {
  applyRepoPatches,
  cloneAllReposSafe,
  getPatchPath,
  hardResetAllReposSafe,
} from './git.util';

// replace __dirname since it is not available in es modules
/* eslint-disable no-underscore-dangle */
let { __filename, __dirname } = globalThis;
if (!__dirname) {
  __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);
}
/* eslint-enable no-underscore-dangle */

// #region handle command-line arguments

const commandLineArgs = process.argv.slice(2);
const COMMAND_LINE_NEGATIVE_PREFIX = 'no-';
function isCommandLineSwitchPresent(switchName: string, negative: boolean) {
  const switchNameNoHyphens = negative
    ? `${COMMAND_LINE_NEGATIVE_PREFIX}${switchName}`.replace(/-/g, '')
    : switchName.replace(/-/g, '');
  return commandLineArgs.some(
    (commandLineArg) =>
      commandLineArg ===
        `${negative ? COMMAND_LINE_NEGATIVE_PREFIX : ''}${switchName.toLowerCase()}` ||
      commandLineArg === switchNameNoHyphens.toLowerCase(),
  );
}

// If no `no-` command line args are present, include the listed build steps
// Otherwise, run all build steps except the ones present with "no-" in front
const shouldIncludePresentBuildSteps =
  commandLineArgs.length > 0 &&
  !commandLineArgs.some((commandLineArg) =>
    commandLineArg.startsWith(COMMAND_LINE_NEGATIVE_PREFIX),
  );

function isBuildStepEnabled(stepName: string) {
  // XAND the values together - include is present and the switch is present
  // or exclude and the switch is not present
  return (
    shouldIncludePresentBuildSteps ===
    isCommandLineSwitchPresent(stepName, !shouldIncludePresentBuildSteps)
  );
}

const shouldClean = isBuildStepEnabled('clean');
const shouldClone = isBuildStepEnabled('clone');
const shouldInstall = isBuildStepEnabled('install');
const shouldSaveRepoPatches = isBuildStepEnabled('save-repo-patches');
const shouldResetBeforeBuild = isBuildStepEnabled('reset-before-build');
const shouldPatch = isBuildStepEnabled('patch');
const shouldPackageExtensions = isBuildStepEnabled('package-extensions');
const shouldCopyPackagedExtensions = isBuildStepEnabled('copy-packaged-extensions');
const shouldEditCore = isBuildStepEnabled('edit-core');
const shouldPackageCore = isBuildStepEnabled('package-core');
const shouldPublish = process.env.BUILD_PUBLISH !== undefined;
const shouldMoveDistFiles = isBuildStepEnabled('move-dist-files');
const shouldResetAfterBuild = isBuildStepEnabled('reset-after-build');

console.log('Build steps enabled:', {
  shouldClean,
  shouldClone,
  shouldInstall,
  shouldSaveRepoPatches,
  shouldResetBeforeBuild,
  shouldPatch,
  shouldPackageExtensions,
  shouldCopyPackagedExtensions,
  shouldEditCore,
  shouldPackageCore,
  shouldPublish,
  shouldMoveDistFiles,
  shouldResetAfterBuild,
});

// #endregion

(async () => {
  let exitCode = 0;

  // Remove temp build files
  if (shouldClean) {
    await import('./clean');
  }

  console.log(`Building ${productInfo.productName}`);

  // Clone repos
  if (shouldClone && !(await cloneAllReposSafe())) return 1;

  // npm ci everything
  if (shouldInstall && !(await npmCiAllReposSafe())) return 1;

  // Save the repo patches at their current state so we can reset to them later without losing edits
  if (shouldSaveRepoPatches) {
    await import('./save-repo-patches');
  }

  // Reset the repos to prepare them for the custom patching
  if (shouldResetBeforeBuild && !(await hardResetAllReposSafe())) return 1;

  // Apply the current patch to all repos (replace productInfo keys with values)
  if (shouldPatch) {
    console.log('Replacing {{ productInfo.keys }} with values in repo patches');
    // Load patches and replace productInfo keys with values
    const patchDirSource = getPatchPath('');

    // Make sure the patch folder exists because who wants to deal with it not existing
    await fs.mkdir(patchDirSource, { recursive: true });

    // Discover all the patch files
    const patchRepoNames = (await fs.readdir(patchDirSource))
      .filter((fileName) => fileName.endsWith('.patch'))
      .map((patchName) => patchName.slice(0, -'.patch'.length));

    // Load patches, insert productInfo values, and save patches
    await Promise.all(
      patchRepoNames.map(async (patchRepoName) => {
        const patchPath = getPatchPath(patchRepoName);
        // Load patch
        let patch = await fs.readFile(patchPath, 'utf-8');

        // Inject productInfo values
        patch = patch.replace(
          /{{\s*productInfo.(\S+)\s*}}/g,
          function replaceProductInfoKey(_fullMatch, productInfoKey) {
            return `${productInfo[productInfoKey]}`;
          },
        );

        // Make sure the temp patch folder exists
        await fs.mkdir(getPatchPath('', TEMP_BUILD_FOLDER), { recursive: true });

        // Save modified patches to temp dir
        await fs.writeFile(getPatchPath(patchRepoName, TEMP_BUILD_FOLDER), patch, 'utf-8');
      }),
    );

    // Apply modified patches
    await applyRepoPatches(TEMP_BUILD_FOLDER);
  }

  // Package multi-extension repos
  if (shouldPackageExtensions) {
    await Promise.all(
      MULTI_EXTENSION_REPOS_INFO.map(async (repoInfo) => {
        try {
          await execCommand('npm run package', {
            pathFromRepoRoot: repoInfo.dir,
            prefix: repoInfo.name,
          });
        } catch (e) {
          console.error(`Error on running npm run package for ${repoInfo.name}: ${e}`);
          exitCode = 1;
        }
      }),
    );
    if (exitCode !== 0) return exitCode;
  }

  // Copy multi-extension packaged files to core
  if (shouldCopyPackagedExtensions) {
    // We want to run these one-at-a-time, so we're using for/of instead of .forEach
    // eslint-disable-next-line no-restricted-syntax
    for (const repoInfo of MULTI_EXTENSION_REPOS_INFO) {
      try {
        console.log(
          `Copying packaged extensions from ${repoInfo.name} into ${CORE_REPO_INFO.name}`,
        );
        // We want to run these one-at-a-time, so we're using for/of instead of .forEach
        // eslint-disable-next-line no-await-in-loop
        await fs.cp(
          path.resolve(repoInfo.dir, 'release'),
          path.resolve(CORE_REPO_INFO.dir, ADDITIONAL_EXTENSIONS_FOLDER),
          { recursive: true },
        );
      } catch (e) {
        console.error(`Error on copying packaged extension files for ${repoInfo.name}: ${e}`);
        exitCode = 1;
        break;
      }
    }
    if (exitCode !== 0) return exitCode;
  }

  // #region Make edits to core

  if (shouldEditCore) {
    // #region electron-builder.json5

    console.log(`Making edits to ${CORE_REPO_INFO.name}'s electron-builder config`);

    // Load up the electron builder config
    const electronBuilderConfigPath = path.resolve(CORE_REPO_INFO.dir, 'electron-builder.json5');
    const electronBuilderConfigJson5 = await fs.readFile(electronBuilderConfigPath, 'utf-8');
    const electronBuilderConfig = json5.parse(electronBuilderConfigJson5);

    // Update product details
    electronBuilderConfig.productName = productInfo.productName;
    electronBuilderConfig.appId = productInfo.appId;
    electronBuilderConfig.copyright = productInfo.copyright;
    electronBuilderConfig.publish = productInfo.electronBuilderPublish;
    electronBuilderConfig.protocols.name = productInfo.name;
    electronBuilderConfig.protocols.schemes = [productInfo.name];

    // Add additional extensions folder to electron builder config
    const additionalExtensionsCopyInstructions = {
      from: `./${ADDITIONAL_EXTENSIONS_FOLDER}`,
      to: './extensions',
    };
    if (
      !electronBuilderConfig.extraResources.some(
        (copyInstructions: string | { from: string; to: string }) =>
          typeof copyInstructions === 'object' &&
          copyInstructions.from === additionalExtensionsCopyInstructions.from &&
          copyInstructions.to === additionalExtensionsCopyInstructions.to,
      )
    )
      electronBuilderConfig.extraResources.push(additionalExtensionsCopyInstructions);

    // Write the modified electron-builder.json5
    await fs.writeFile(
      electronBuilderConfigPath,
      json5.stringify(electronBuilderConfig, undefined, 2),
      'utf-8',
    );

    // #endregion

    // #region release/app/package.json

    console.log(`Making edits to ${CORE_REPO_INFO.name}'s release package config`);

    // Load up release/app/package.json
    const releaseAppPackagePath = path.resolve(
      CORE_REPO_INFO.dir,
      'release',
      'app',
      'package.json',
    );
    const releaseAppPackageJson = await fs.readFile(releaseAppPackagePath, 'utf-8');
    const releaseAppPackage = JSON.parse(releaseAppPackageJson);

    // Update product details
    releaseAppPackage.name = productInfo.name;
    releaseAppPackage.version = productInfo.version;
    releaseAppPackage.description = productInfo.description;
    releaseAppPackage.author = productInfo.author;

    // Write the modified release/app/package.json
    await fs.writeFile(
      releaseAppPackagePath,
      JSON.stringify(releaseAppPackage, undefined, 2),
      'utf-8',
    );

    // #endregion

    // Copy asset folder
    try {
      console.log(`Overwriting ${CORE_REPO_INFO.name} asset files with ours`);

      await fs.cp(
        path.resolve(__dirname, '..', 'assets'),
        path.resolve(CORE_REPO_INFO.dir, 'assets'),
        {
          recursive: true,
        },
      );
    } catch (e) {
      console.error(`Error on overwriting ${CORE_REPO_INFO.name} asset files with ours: ${e}`);
      exitCode = 1;
    }
  }
  if (exitCode !== 0) return exitCode;

  // #endregion

  // Package core
  if (shouldPackageCore) {
    // This is the same as how `paranext-core`'s `package-main.yml` packages builds
    try {
      await execCommand('npm run build', {
        pathFromRepoRoot: CORE_REPO_INFO.dir,
        prefix: CORE_REPO_INFO.name,
      });
    } catch (e) {
      console.error(`Error on running npm build for ${CORE_REPO_INFO.name}: ${e}`);
      exitCode = 1;
    }
    if (exitCode !== 0) return exitCode;

    let osName = 'linux';
    switch (process.platform) {
      case 'win32':
        osName = 'win';
        break;
      case 'darwin':
        osName = 'mac';
        break;
      default:
        break;
    }

    try {
      const buildCommand = shouldPublish
        ? `npm exec electron-builder -- --publish always --${osName}`
        : `npm exec electron-builder -- build --publish never --${osName}`;
      await execCommand(buildCommand, {
        pathFromRepoRoot: CORE_REPO_INFO.dir,
        prefix: CORE_REPO_INFO.name,
      });
    } catch (e) {
      console.error(
        `Error on running electron-builder build${shouldPublish ? 'and publish' : ''} for ${CORE_REPO_INFO.name} on ${osName}: ${e}`,
      );
      exitCode = 1;
    }
    if (exitCode !== 0) return exitCode;
  }

  // Copy the build files over to the dist folder
  if (shouldMoveDistFiles) {
    try {
      console.log(
        `Cleaning out ${BUILT_FILES_DESTINATION_FOLDER} folder and copying newly built files to it`,
      );
      const destinationPath = path.resolve(__dirname, '..', BUILT_FILES_DESTINATION_FOLDER);

      // Clean dist folder
      await rimraf(destinationPath);

      // Copy built files to dist
      await fs.cp(path.resolve(CORE_REPO_INFO.dir, 'release', 'build'), destinationPath, {
        recursive: true,
      });
    } catch (e) {
      console.error(
        `Error on cleaning out ${BUILT_FILES_DESTINATION_FOLDER} folder and copying newly built files to it: ${e}`,
      );
      exitCode = 1;
    }
  }
  if (exitCode !== 0) return exitCode;

  // Reset all repos and get ready for continuing to edit
  if (shouldResetAfterBuild) {
    await import('./reset-and-patch');
  }

  return exitCode;
})()
  .then((exitCode) => {
    console.log(
      exitCode === 0
        ? `Successfully built ${productInfo.productName}`
        : `Failed to build ${productInfo.productName}`,
    );

    process.exitCode = exitCode;

    return exitCode;
  })
  .catch((err) => {
    console.error(`Error thrown while building ${productInfo.productName}: ${err}`);

    process.exitCode = 1;
  });
