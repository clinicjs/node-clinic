const fs = require('fs')
const path = require('path')
const { promisify } = require('util')
const { spawn } = require('child_process')
const inquirer = require('inquirer')
const dedent = require('dedent')
const tmp = require('tmp')

module.exports = getAskMessage

const access = promisify(fs.access)
const writeFile = promisify(fs.writeFile)
const readFile = promisify(fs.readFile)
const stat = promisify(fs.stat)
const unlink = promisify(fs.unlink)

function getDefaultEditor () {
  const platformDefault = process.platform === 'win32' ? 'notepad' : 'vim'
  return process.env.EDITOR || process.env.VISUAL || platformDefault
}

async function runEditor (editor, filename) {
  const args = []
  if (editor === 'vim') {
    args.push('+star') // start vim in insert mode
    args.push('+') // and on the last line
  }
  args.push(filename)

  const startStat = await stat(filename)

  const proc = spawn(editor, args, { stdio: 'inherit' })
  const startTime = Date.now()
  await new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', () => resolve())
  })

  const endStat = await stat(filename)
  const hasSaved = endStat.mtime > startStat.mtime

  // If it exited really quickly without updating the file, it might have forked, and we should wait for the message to be written
  // (visual editors like VS Code like to do this)
  if (Date.now() - startTime < 2000 && !hasSaved) {
    const prompt = await inquirer.prompt({
      type: 'confirm',
      name: 'continue',
      message: 'Could not determine whether the editor is closed. Please type your message and save the file, and then press Y or Enter to continue. Press N to abort.',
      default: true
    })

    if (!prompt.continue) {
      throw new Error('Empty message--aborting Ask.')
    }
  }
}

async function getAskMessage (dirname) {
  const basename = path.basename(dirname)
  const editor = getDefaultEditor()
  let header = dedent`
    # Asking for help with: ${basename}
    # Please enter your question below. There is no specific formatting, but
    # feel free to use Markdown if you need to.
  `
  if (editor === 'vim') {
    header += '\n' + dedent`
      #
      # You've been dropped into vim, already in 'insert mode'.
      # After writing your message, to save and exit, press Escape then type :wq
   `
  }
  header += '\n' + dedent`
    #
    # ---- type below ----
  `
  const defaultMessage = `${header}\n\n\n`

  const messageFileAttempts = [
    path.join(dirname, 'ASK_MESSAGE'),
    // in case the above is not writable or doesn't exist
    tmp.tmpNameSync({ name: `${basename}-ASK_MESSAGE` })
  ]
  let messageFile
  for (const attempt of messageFileAttempts) {
    try {
      // If a previous message still exists, probably something crashed
      // down the line, we can just restore it
      await access(attempt)
      messageFile = attempt
      break
    } catch (err) {
      try {
        await writeFile(attempt, defaultMessage)
        messageFile = attempt
        break
      } catch (err) {
        // try next
      }
    }
  }

  if (process.stdout.isTTY && !process.env.CI) {
    await runEditor(editor, messageFile)
  } else if (process.env.CLINIC_MOCK_ASK_MESSAGE) {
    await writeFile(messageFile, process.env.CLINIC_MOCK_ASK_MESSAGE)
  } else {
    throw new Error('Could not start editor')
  }

  let message = await readFile(messageFile, 'utf8')
  message = message.replace(header, '')

  if (message.trim() === '') {
    const err = new Error('Empty message--aborting Ask.')
    err.code = 'NoMessage'
    throw err
  }

  async function cleanup () {
    try {
      await unlink(messageFile)
    } catch (err) {
      // ignore
    }
  }

  return {
    message,
    cleanup
  }
}
