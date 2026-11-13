import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDirectory = fileURLToPath(new URL('../test/', import.meta.url))
const repositoryRoot = path.resolve(testDirectory, '..')
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      return collectTestFiles(entryPath)
    }

    return entry.isFile() && testFilePattern.test(entry.name) ? [entryPath] : []
  }))

  return nestedFiles.flat()
}

const testFiles = (await collectTestFiles(testDirectory)).sort()

if (testFiles.length === 0) {
  throw new Error(`No test files found in ${testDirectory}`)
}

// Keep the argument list independent of the checkout's absolute path. The
// Windows process command-line limit was exceeded in nested worktrees when
// every absolute test path was passed to one Node process. Four workers also
// avoid collisions between the few browser tests that bind the same Vite port.
const relativeTestFiles = testFiles.map((file) => path.relative(repositoryRoot, file))
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...relativeTestFiles], {
  cwd: repositoryRoot,
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}

if (result.signal) {
  throw new Error(`Test runner exited after receiving ${result.signal}`)
}

process.exitCode = result.status ?? 1
