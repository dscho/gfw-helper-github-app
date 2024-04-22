const githubApiRequest = require('./github-api-request')

const sleep = async (milliseconds) => {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
    })
}

const waitForWorkflowRunToFinish = async (context, token, owner, repo, workflowRunId) => {
    let counter = 0
    for (;;) {
        const res = await githubApiRequest(
            context,
            token,
            'GET',
            `/repos/${owner}/${repo}/actions/runs/${workflowRunId}`
        )
        if (res.status === 'completed') {
            if (res.conclusion !== 'success') throw new Error(`Workflow run ${workflowRunId} completed with ${res.conclusion}!`)
            return res
        }
        if (context.log) context.log(`Waiting for workflow run ${workflowRunId} (current status: ${res.status})`)
        if (counter++ > 30) throw new Error(`Times out waiting for workflow run ${workflowRunId}?`)
        await sleep(1000)
    }
}

const getActorWhoTriggeredWorkflowRun = async (context, token, owner, repo, workflowRunId) => {
    const res = await githubApiRequest(
        context,
        token,
        'GET',
        `/repos/${owner}/${repo}/actions/runs/${workflowRunId}`
    )
    return res.triggering_actor.login
}

const wasWorkflowRunDeleted = async (context, token, owner, repo, workflowRunId) => {
    try {
        await githubApiRequest(
            context,
            token,
            'GET',
            `/repos/${owner}/${repo}/actions/runs/${workflowRunId}`
        )
        return false
    } catch (error) {
        context.log(`Workflow run ${workflowRunId} was deleted (${error}).`)
        return true
    }
}

module.exports = {
    waitForWorkflowRunToFinish,
    getActorWhoTriggeredWorkflowRun,
    wasWorkflowRunDeleted
}