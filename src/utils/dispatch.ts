import execa from 'execa'
import { log } from '..'

export const dispatch = (
  cmd: string,
  args?: string[],
  cwd?: string,
  killOnError?: boolean,
  logger = (data: string) => log.info(data)
): Promise<boolean> => {
  const handle = (data: string | Error, killOnError?: boolean) => {
    const d = data.toString()

    d.split('\n').forEach((line: string) => {
      if (line.length !== 0) logger(line.replace(/\s\d{1,5}:\d\d\.\d\d /g, ''))
    })

    if (killOnError) {
      log.error('Command failed. See error above.')
      process.exit(1)
    }
  }

  return new Promise((resolve) => {
    process.env.MACH_USE_SYSTEM_PYTHON = 'true'

    const proc = execa(cmd, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
    })

    proc.stdout?.on('data', (d) => handle(d))
    proc.stderr?.on('data', (d) => handle(d))

    proc.stdout?.on('error', (d) => handle(d, killOnError))
    proc.stderr?.on('error', (d) => handle(d, killOnError))

    proc.on('exit', () => {
      resolve(true)
    })
  })
}
