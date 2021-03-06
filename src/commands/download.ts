import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, join, posix, resolve, sep } from 'path'

import execa from 'execa'
import Listr from 'listr'

import { bin_name, config, log } from '..'
import { ENGINE_DIR, MELON_TMP_DIR } from '../constants'
import {
  ensureDir,
  getConfig,
  walkDirectoryTree,
  writeMetadata,
} from '../utils'
import { downloadFileToLocation } from '../utils/download'
import { downloadArtifacts } from './download-artifacts'
import { discard, init } from '.'

const gFFVersion = getConfig().version.version

export const download = async (): Promise<void> => {
  const version = gFFVersion

  // If gFFVersion isn't specified, provide legible error
  if (!version) {
    log.error(
      'You have not specified a version of firefox in your config file. This is required to build a firefox fork'
    )
    process.exit(1)
  }

  const addons = Object.keys(config.addons).map((addon) => ({
    name: addon,
    ...config.addons[addon],
  }))

  await new Listr([
    {
      title: 'Downloading firefox source',
      skip: () => {
        if (
          existsSync(ENGINE_DIR) &&
          existsSync(resolve(ENGINE_DIR, 'toolkit', 'moz.build'))
        ) {
          return 'Firefox has already been downloaded, unpacked and inited'
        }
      },
      task: async (ctx, task) => {
        ctx.firefoxSourceTar = await downloadFirefoxSource(version, task)
      },
    },
    {
      title: 'Unpack firefox source',
      enabled: (ctx) => ctx.firefoxSourceTar,
      task: async (ctx, task) => {
        await unpackFirefoxSource(ctx.firefoxSourceTar, task)
      },
    },
    {
      title: 'Install windows artifacts',
      enabled: (ctx) => process.platform == 'win32',
      task: async (ctx) => {
        if (existsSync(resolve(homedir(), '.mozbuild'))) {
          log.info('Mozbuild directory already exists, not redownloading')
        } else {
          log.info('Mozbuild not found, downloading artifacts.')
          await downloadArtifacts()
        }
      },
    },
    {
      title: 'Init firefox',
      enabled: (ctx) => ctx.firefoxSourceTar && !process.env.CI_SKIP_INIT,
      task: async (_ctx, task) => await init(ENGINE_DIR, task),
    },
    ...addons
      .map((addon) => includeAddon(addon.name, addon.url, addon.id))
      .reduce((acc, cur) => [...acc, ...cur], []),
    {
      title: 'Add addons to mozbuild',
      task: async (ctx, task) => {
        // Discard the file to make sure it has no changes
        await discard('browser/extensions/moz.build', {})

        const path = join(ENGINE_DIR, 'browser', 'extensions', 'moz.build')

        // Append all the files to the bottom
        writeFileSync(
          path,
          `${readFileSync(path, 'utf8')}\nDIRS += [${addons
            .map((addon) => addon.name)
            .sort()
            .map((addon) => `"${addon}"`)
            .join(',')}]`
        )
      },
    },
    {
      title: 'Write metadata',
      task: () => writeMetadata(),
    },
    {
      title: 'Cleanup',
      task: (ctx) => {
        let cwd = process.cwd().split(sep).join(posix.sep)

        if (process.platform == 'win32') {
          cwd = './'
        }

        if (ctx.firefoxSourceTar) {
          unlinkSync(resolve(cwd, '.dotbuild', 'engines', ctx.firefoxSourceTar))
        }
      },
    },
  ]).run()

  log.success(
    `You should be ready to make changes to ${config.name}.\n\n\t   You should import the patches next, run |${bin_name} import|.\n\t   To begin building ${config.name}, run |${bin_name} build|.`
  )
  console.log()
}

const includeAddon = (
  name: string,
  downloadURL: string,
  id: string
): Listr.ListrTask<any>[] => {
  const tempFile = join(MELON_TMP_DIR, name + '.xpi')
  const outPath = join(ENGINE_DIR, 'browser', 'extensions', name)

  return [
    {
      title: `Download addon from ${downloadURL}`,
      skip: () => {
        if (existsSync(outPath)) {
          return `${downloadURL} has already been loaded to ${name}`
        }
      },
      task: async (ctx, task) => {
        await downloadFileToLocation(
          downloadURL,
          tempFile,
          (msg) => (task.output = msg)
        )
        ctx[name] = tempFile
      },
    },
    {
      title: `Unpack to ${name}`,
      enabled: (ctx) => typeof ctx[name] !== 'undefined',
      task: (ctx, task) => {
        const onData = (data: any) => {
          const d = data.toString()

          d.split('\n').forEach((line: any) => {
            if (line.trim().length !== 0) {
              const t = line.split(' ')
              t.shift()
              task.output = t.join(' ')
            }
          })
        }

        task.output = `Unpacking extension...`

        return new Promise<void>((res) => {
          mkdirSync(outPath, {
            recursive: true,
          })

          const tarProc = execa('unzip', [ctx[name], '-d', outPath])

          tarProc.stdout?.on('data', onData)
          tarProc.stdout?.on('error', (data) => {
            throw data
          })

          tarProc.on('exit', () => {
            task.output = ''
            res()
          })
        })
      },
    },
    {
      title: 'Generate mozbuild',
      enabled: (ctx) => typeof ctx[name] !== 'undefined',
      task: async (ctx, task) => {
        const files = await walkDirectoryTree(outPath)

        function runTree(tree: any, parent: string): string {
          if (Array.isArray(tree)) {
            return tree
              .sort()
              .map(
                (file) =>
                  `FINAL_TARGET_FILES.features["${id}"]${parent} += ["${file
                    .replace(outPath + '/', '')
                    .replace(outPath, '')}"]`
              )
              .join('\n')
          }

          const current = (tree['.'] as string[])
            .sort()
            .map(
              (f) =>
                `FINAL_TARGET_FILES.features["${id}"]${parent} += ["${f
                  .replace(outPath + '/', '')
                  .replace(outPath, '')}"]`
            )
            .join('\n')

          const children = Object.keys(tree)
            .filter((folder) => folder !== '.')
            .filter((folder) => typeof tree[folder] !== 'undefined')
            .map((folder) => runTree(tree[folder], `${parent}["${folder}"]`))
            .join('\n')

          return `${current}\n${children}`
        }

        writeFileSync(
          join(outPath, 'moz.build'),
          `
DEFINES["MOZ_APP_VERSION"] = CONFIG["MOZ_APP_VERSION"]
DEFINES["MOZ_APP_MAXVERSION"] = CONFIG["MOZ_APP_MAXVERSION"]

${runTree(files, '')}`
        )
      },
    },
  ]
}

async function unpackFirefoxSource(
  name: string,
  task: Listr.ListrTaskWrapper<any>
): Promise<void> {
  let cwd = process.cwd().split(sep).join(posix.sep)

  if (process.platform == 'win32') {
    cwd = './'
  }

  task.output = `Unpacking Firefox...`

  if (existsSync(ENGINE_DIR)) rmdirSync(ENGINE_DIR)
  mkdirSync(ENGINE_DIR)

  try {
    await execa(
      'tar',
      [
        '--transform',
        `s,firefox-${gFFVersion},engine,`,
        `--show-transformed`,
        process.platform == 'win32' ? '--force-local' : null,
        '-xf',
        resolve(cwd, '.dotbuild', 'engines', name),
      ].filter((x) => x) as string[]
    )
  } catch (e) {
    const error = e as unknown as Error
    error.message = `\nThe following error may have been caused because you are using bsdtar.
For MacOS users, please run |brew install gnu-tar| if the error includes "--transform is not supported"
${error.message}\n`

    throw e
  }
}

async function downloadFirefoxSource(
  version: string,
  task: Listr.ListrTaskWrapper<any>
) {
  const base = `https://archive.mozilla.org/pub/firefox/releases/${version}/source/`
  const filename = `firefox-${version}.source.tar.xz`

  const url = base + filename

  task.output = `Locating Firefox release ${version}...`

  await ensureDir(resolve(process.cwd(), `.dotbuild`, `engines`))

  if (
    existsSync(
      resolve(
        process.cwd(),
        `.dotbuild`,
        `engines`,
        `firefox-${version.split('b')[0]}`
      )
    )
  ) {
    log.error(
      `Cannot download version ${
        version.split('b')[0]
      } as it already exists at "${resolve(
        process.cwd(),
        `firefox-${version.split('b')[0]}`
      )}"`
    )
  }

  if (version.includes('b'))
    task.output =
      'WARNING Version includes non-numeric characters. This is probably a beta.'

  // Do not re-download if there is already an existing workspace present
  if (existsSync(ENGINE_DIR)) {
    log.error(
      `Workspace already exists.\nRemove that workspace and run |${bin_name} download ${version}| again.`
    )
  }

  task.output = `Downloading Firefox release ${version}...`

  await downloadFileToLocation(
    url,
    resolve(process.cwd(), `.dotbuild`, `engines`, filename)
  )
  return filename
}
