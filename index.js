const core = require('@actions/core')
const {context, getOctokit} = require('@actions/github')
const util = require('node:util')
const { WebClient } = require('@slack/web-api');

process.on('unhandledRejection', handleError)
main().catch(handleError)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function durationToString(seconds) {
  const hours = Math.floor(seconds / 3600)
  seconds -= hours * 3600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60
  seconds = Math.round(seconds)

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`
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

async function monitor({importantSteps, github, deployDescription, stepIdentifier, slack, slackChannel}) {
  let messageTs = null

  while (true) {
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

    const importantJobs = jobs.filter(job => job.id != statusJob.id)
    // Nothing to do
    if (importantJobs.length == 0) {
      break
    }

    let active = []
    let completed = []

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
    const logUrl = importantJobs[0].html_url

    let color
    if (jobsCompleted) {
      if (allSuccess) {
        color = "#28A745" // "good" doesn't work
      } else {
        color = "#D90000" // "danger" doesn't work
      }

      // Clear active steps if the job is completed to mitigate
      // issues with the GitHub API returning stale data
      active = []
    }

    const deploying_emoji = jobsCompleted ? (allSuccess ? "✅" : "❌") : "⏳"
    let description = `${deploying_emoji} ${jobsCompleted ? 'Deployed' : 'Deploying' } ${deployDescription}`
    if (jobsCompleted) {
      let jobStartAt = Math.min(...jobs.map(job => new Date(job.started_at)))
      description += ` in ${durationToString((Date.now() - jobStartAt) / 1000)}`
    }

    let message = `${deploying_emoji} ${jobsCompleted ? 'Deployed' : 'Deploying' } ${deployDescription}\n`
    if (active.length > 0) {
      message += active.join("\n") + "\n"
    }
    if (completed.length > 0) {
      message += completed.join("\n") + "\n"
    }

    console.log("----------")
    console.log(message)

    if (messageTs) {
      // await slack.chat.update({ ts: messageTs, channel: slackChannel, text: message, blocks: formatMessage({description, active, completed, logUrl}) })
      await slack.chat.update({ ts: messageTs, channel: slackChannel, attachments: [{ color, fallback: message, blocks: formatMessage({description, active, completed, logUrl}) }] })
    } else {
      // let response = await slack.chat.postMessage({ channel: slackChannel, text: message, blocks: formatMessage({description, active, completed, logUrl}) })
      let response = await slack.chat.postMessage({ channel: slackChannel, attachments: [{ color, fallback: message, blocks: formatMessage({description, active, completed, logUrl}) }] })
      core.debug(`response = ${util.inspect(response, { depth: 8 })}`)
      messageTs = response.ts
      slackChannel = response.channel
    }

    console.log("importantJobs = " + util.inspect(importantJobs, { depth: 8 }))

    if (jobsCompleted) {
      break
    }

    await sleep(2000)
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

  const opts = {}
  if (debug === 'true') {
    opts.log = console
  }

  const github = getOctokit(token, opts)

  core.debug("context = " + util.inspect(context))

  const slack = new WebClient(botToken);

  await monitor({importantSteps, github, deployDescription, stepIdentifier, slack, slackChannel})
}

function handleError(err) {
  console.error(err)
  core.setFailed(`Unhandled error: ${err}`)
}