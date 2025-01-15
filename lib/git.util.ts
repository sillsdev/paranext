import path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs/promises';
import { execCommand } from './build.util';
import { ALL_REPOS_INFO } from './product-info.data';

/* eslint-disable no-underscore-dangle */
let { __filename, __dirname } = globalThis;
if (!__dirname) {
  __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);
}
/* eslint-enable no-underscore-dangle */

/** Name of folder in which to save patches to repositories */
const REPO_PATCH_FOLDER = 'repo-patches';

/**
 * Get absolute path to file in which to save patch to repository
 *
 * @param repoName Name of repo to patch. Provide empty string to get the directory itself
 * @param pathFromRepoRoot Path from repo root to directory in which to put the patch folder. Note
 *   that this is not the folder the patches will go in; in this folder, a folder called
 *   {@link REPO_PATCH_FOLDER} will contain the patches. Defaults to repo root
 * @returns
 */
export function getPatchPath(repoName: string, pathFromRepoRoot = '') {
  return `${path.resolve(__dirname, '..', pathFromRepoRoot, REPO_PATCH_FOLDER, repoName)}${repoName !== '' ? '.patch' : ''}`;
}

/**
 * Clone all repos configured in `productInfo.json`. Logs instead of throwing errors
 *
 * @param shouldReturnEarlyOnError Whether to log the first error thrown and stop cloning repos. If
 *   `false`, tries to clone each repo regardless of success. Defaults to `true`
 * @returns `true` if successfully cloned all repos, `false` otherwise (if
 *   `shouldReturnEarlyOnError` is `false`, still tries to clone all repos regardless of individual
 *   success)
 */
export async function cloneAllReposSafe(shouldReturnEarlyOnError = true) {
  let allSucceeded = true;
  // We want to run these one-at-a-time, so we're using for/of instead of .forEach
  // eslint-disable-next-line no-restricted-syntax
  for (const repoInfo of ALL_REPOS_INFO) {
    try {
      // We want to run these one-at-a-time, so we're using for/of instead of .forEach
      // eslint-disable-next-line no-await-in-loop
      await execCommand(
        `git clone -b ${repoInfo.branch} --single-branch ${repoInfo.uri} ${repoInfo.dir}`,
      );
    } catch (e) {
      if (shouldReturnEarlyOnError) {
        console.error(`Error on cloning ${repoInfo.name}: ${e}`);
        return false;
      }
      allSucceeded = false;
    }
  }

  return allSucceeded;
}

/**
 * Hard reset all repos configured in `productInfo.json`. Logs instead of throwing errors
 *
 * @returns `true` if successfully hard reset all repos, `false` otherwise
 */
export async function hardResetAllReposSafe() {
  // Hard reset all changes including untracked files
  // We want to run these one-at-a-time, so we're using for/of instead of .forEach
  // eslint-disable-next-line no-restricted-syntax
  for (const repoInfo of ALL_REPOS_INFO) {
    try {
      // Staging all files lets us remove untracked files
      // We want to run these one-at-a-time, so we're using for/of instead of .forEach
      // eslint-disable-next-line no-await-in-loop
      await execCommand('git add .', {
        pathFromRepoRoot: repoInfo.dir,
        prefix: repoInfo.name,
      });
      // We want to run these one-at-a-time, so we're using for/of instead of .forEach
      // eslint-disable-next-line no-await-in-loop
      await execCommand(`git reset --hard`, {
        pathFromRepoRoot: repoInfo.dir,
        prefix: repoInfo.name,
      });
    } catch (e) {
      console.error(
        `Error on staging all files and hard resetting changes to ${repoInfo.name}: ${e}`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Applies the current patch to all repos
 *
 * @param pathFromRepoRoot Path from repo root to directory in which to get the patch folder. Note
 *   that this is not the folder the patches will be in; in this folder, a folder called
 *   {@link REPO_PATCH_FOLDER} will contain the patches. Defaults to repo root
 */
export async function applyRepoPatches(pathFromRepoRoot = '') {
  console.log('Applying patches to each repo');

  // Apply a patch for each repo
  // We want to run these one-at-a-time, so we're using for/of instead of .forEach
  // eslint-disable-next-line no-restricted-syntax
  for (const repoInfo of ALL_REPOS_INFO) {
    try {
      const patchPath = getPatchPath(repoInfo.name, pathFromRepoRoot);
      let shouldSkip = true;
      // Check to see if a patch exists for this repo
      try {
        // We want to run these one-at-a-time, so we're using for/of instead of .forEach
        // eslint-disable-next-line no-await-in-loop
        await fs.access(patchPath);
        shouldSkip = false;
      } catch {
        // Do nothing
      }

      if (!shouldSkip) {
        // Apply the patch with 3-way merge resolution if the patch doesn't apply cleanly so they can
        // resolve the conflicts and continue to edit the repos
        // Ignore whitespace because some people are seeing troubles with CRLF on Windows
        // We want to run these one-at-a-time, so we're using for/of instead of .forEach
        // eslint-disable-next-line no-await-in-loop
        await execCommand(
          `git apply --3way --allow-empty --verbose --ignore-whitespace "${patchPath}"`,
          {
            pathFromRepoRoot: repoInfo.dir,
            prefix: repoInfo.name,
          },
        );
      }
    } catch (e) {
      console.error(`Error on applying git patch for ${repoInfo.name}: ${e}`);
      process.exit(1);
    }
  }

  console.log('Successfully applied patches to each repo');
}
