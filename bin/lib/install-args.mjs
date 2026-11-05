export const INSTALL_HELP = [
  'Usage: node bin/install.mjs [options]',
  '',
  'Options:',
  '  --profile <name>  DSH profile name (default: DSH_PROFILE or desktop)',
  '  --pin             Refresh the profile lockfile from the local checkout',
  '  --uninstall       Unlink the plugin and remove its profile registrations',
  '  --dry-run         Validate and print the plan without writing anything',
  '  -h, --help        Show this help without reading or changing a profile',
].join('\n')

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class InstallArgumentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallArgumentError'
  }
}

export function validateProfileName(value) {
  if (typeof value !== 'string' || value === '' || !PROFILE_PATTERN.test(value)) {
    throw new InstallArgumentError(
      'invalid profile name ' + JSON.stringify(value) +
      '; use letters, digits, dot, underscore or hyphen, starting with a letter or digit',
    )
  }
  return value
}

/**
 * Parse installer flags without touching the filesystem.
 *
 * Every argument is validated before the caller acts on help. This keeps help
 * side-effect free while ensuring a malformed invocation never falls through
 * to installation.
 */
export function parseInstallArgs(argv) {
  const options = {
    help: false,
    profile: undefined,
    pin: false,
    uninstall: false,
    dryRun: false,
  }

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === '-h' || arg === '--help') {
      options.help = true
      continue
    }
    if (arg === '--pin') {
      options.pin = true
      continue
    }
    if (arg === '--uninstall') {
      options.uninstall = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--profile') {
      if (options.profile !== undefined) {
        throw new InstallArgumentError('--profile may only be specified once')
      }
      const value = argv[at + 1]
      if (value === undefined || value.startsWith('-')) {
        throw new InstallArgumentError('--profile requires a value')
      }
      options.profile = validateProfileName(value)
      at += 1
      continue
    }
    if (arg.startsWith('--profile=')) {
      if (options.profile !== undefined) {
        throw new InstallArgumentError('--profile may only be specified once')
      }
      options.profile = validateProfileName(arg.slice('--profile='.length))
      continue
    }
    if (arg.startsWith('-')) {
      throw new InstallArgumentError('unknown option ' + arg)
    }
    throw new InstallArgumentError('unexpected argument ' + JSON.stringify(arg))
  }

  return options
}
