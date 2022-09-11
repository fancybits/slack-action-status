const core = require('@actions/core')
const {context, getOctokit} = require('@actions/github')
const util = require('node:util')
const { WebClient, LogLevel } = require('@slack/web-api');

const GOOD_COLOR = "#28A745"
const DANGER_COLOR = "#D90000"

process.on('unhandledRejection', handleError)
main().catch(handleError)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function durationToString(seconds) {
  seconds = Math.round(seconds)
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60

  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`
  } else if (minutes > 0) {
    return `${minutes}m${seconds}s`
  } else {
    if (seconds < 1) {
      seconds = 1
    }
    return `${seconds}s`
  }
}

function stepDuration(step) {
  let startedAt = new Date(step.started_at)
  let completedAt = new Date(step.completed_at || Date.now())
  return durationToString((completedAt - startedAt) / 1000)
}

function formatMessage({description, active, completed, logUrl}) {
  const blocks = []

  blocks.push({
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": description
    },
    "accessory": {
      "type": "button",
      "text": {
        "type": "plain_text",
        "text": ":mag: Logs",
        "emoji": true
      },
      "value": "click_logs",
      "url": logUrl,
      "action_id": "button-action"
    }
  })

  if (active.length > 0) {
    blocks.push({
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": active.join("\n")
        }
      ]
    })
  }

  if (completed.length > 0) {
    blocks.push({
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": completed.join("\n")
        }
      ]
    })
  }

  return blocks
}

async function monitor({importantSteps, github, logJobName, deployDescription, stepIdentifier, slack, slackChannel, longJobDuration}) {
  let messageTs, blocks, message, jobStartAt
  let description, active, completed, logUrl

  const sendMessage = async ({color, republish}) => {
    if (republish && messageTs) {
      await slack.chat.delete({ channel: slackChannel, ts: messageTs })
      messageTs = null
    }

    blocks = formatMessage({description, active, completed, logUrl})

    if (messageTs) {
      await slack.chat.update({ ts: messageTs, channel: slackChannel, attachments: [{ color, fallback: message, blocks }] })
    } else {
      let response = await slack.chat.postMessage({ channel: slackChannel, attachments: [{ color, fallback: message, blocks }] })
      core.debug(`response = ${util.inspect(response, { depth: 8 })}`)
      messageTs = response.ts
      slackChannel = response.channel
    }
  }

  const updateDescription = (completed, success) => {
    let emoji = completed ? (success ? "✅" : "❌") : "⏳"
    description = `${emoji} ${completed ? 'Deployed' : 'Deploying' } ${deployDescription}`
    if (completed && jobStartAt) {
      description += ` in ${durationToString((Date.now() - jobStartAt) / 1000)}`
    }
  }

  const reportFailure = (reason) => {
    updateDescription(true, false)
    completed.push(reason)
    sendMessage({color: DANGER_COLOR})
  }

  let running = true
  process.on('SIGINT', () => {
    running = false
    reportFailure("Deploy cancelled")
  })

  try {
    while (running) {
      const {data: {jobs}} = await github.rest.actions.listJobsForWorkflowRunAttempt({
        ...context.repo,
        run_id: context.runId,
        attempt_number: process.env.GITHUB_RUN_ATTEMPT,
      });

      // Use this special identifier to find the job that is running this action
      const statusJob = jobs.find(job =>
        job.steps.find(step =>
          step.name.includes(stepIdentifier)))

      if (!statusJob) {
        throw new Error(`Could not find job with step identifier ${stepIdentifier}`)
      }

      if (!running) {
        break
      }

      const importantJobs = jobs.filter(job => job.id != statusJob.id)
      // Nothing to do
      if (importantJobs.length == 0) {
        break
      }

      logUrl = (importantJobs.find(j => j.name.includes(logJobName)) || importantJobs[0]).html_url
      jobStartAt = Math.min(...jobs.map(job => new Date(job.started_at)))
      active = []
      completed = []

      for (const job of importantJobs) {
        for (const step of job.steps) {
          const emoji = process.env[`STATUS_${step.name.replace(/ /g, '_').toUpperCase()}_EMOJI`] || "🛠"

          if (step.status == "completed") {
            if (step.conclusion == "success") {
              // Don't include successful steps that aren't important
              if (!importantSteps.includes(step.name)) {
                continue
              }

              completed.push(`${emoji} ${step.name} completed in ${stepDuration(step)}`)
            } else if (step.conclusion == "skipped") {
              // all good
            } else {
              completed.push(`${step.name} failed after ${stepDuration(step)}`)
            }
          } else if (step.status == "in_progress") {
            active.push(`${emoji} ${step.name} running for ${stepDuration(step)}...`)
          }
        }
      }

      const jobsCompleted = !importantJobs.find(job => job.status == "in_progress" || job.status == "queued")
      const allSuccess = !importantJobs.find(job => job.conclusion != "success")

      let color
      if (jobsCompleted) {
        if (allSuccess) {
          color = GOOD_COLOR // "good" doesn't work
        } else {
          color = DANGER_COLOR // "danger" doesn't work
        }

        // Clear active steps if the job is completed to mitigate
        // issues with the GitHub API returning stale data
        if (active.length > 0) {
          console.log("importantJobs = " + util.inspect(importantJobs, { depth: 8 }))
          active = []
        }
      }

      updateDescription(jobsCompleted, allSuccess)

      message = `${description}\n`
      if (active.length > 0) {
        message += active.join("\n") + "\n"
      }
      if (completed.length > 0) {
        message += completed.join("\n") + "\n"
      }

      console.log("----------\n" + message)

      // If the job is completed and it has been running for a long time, delete the message so it is reposted as a new message
      let republish = jobsCompleted && (Date.now() - jobStartAt) / 1000 > longJobDuration
      sendMessage({color, republish})

      if (jobsCompleted) {
        break
      }

      await sleep(10000)
    }
  } catch (error) {
    reportFailure("⚠️ Status reporter failed: " + error.message)
    throw error
  }
}

async function main() {
  const token = core.getInput('github-token', {required: true})
  const debug = core.getInput('debug')
  const stepIdentifier = core.getInput('step-identifier', {required: true})
  const deployDescription = core.getInput('deploy-description') || `${context.repository.repo} from \`${context.ref_name}\` (${context.sha.substring(0, 7)})`
  const importantSteps = core.getInput('important-steps').split(',').map(s => s.trim())
  const botToken = core.getInput('slack-bot-token', {required: true})
  const slackChannel = core.getInput('slack-channel-id', {required: true})
  const logJobName = core.getInput('log-job-name')
  const longJobDuration = core.getInput('long-job-duration')

  const opts = {}
  if (debug === 'true') {
    opts.log = console
  }

  core.debug("context = " + util.inspect(context))

  const github = getOctokit(token, opts)
  const slack = new WebClient(botToken, { logLevel: LogLevel.ERROR })

  await monitor({importantSteps, github, deployDescription, logJobName, stepIdentifier, slack, slackChannel, longJobDuration})
}

function handleError(err) {
  console.error(err)
  core.setFailed(`Unhandled error: ${err}`)
}