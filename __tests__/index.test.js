const index = require('../GitForWindowsHelper/index')
const crypto = require('crypto')

process.env['GITHUB_WEBHOOK_SECRET'] = 'for-testing'

test('reject requests other than webhook payloads', async () => {
    const context = {
        log: jest.fn(),
        req: {
            method: 'GET'
        }
    }

    const expectInvalidWebhook = async (message) => {
        context.log.mockClear()
        expect(await index(context, context.req)).toBeUndefined()
        expect(context.log).toHaveBeenCalledTimes(1)
        // context.log was called with an instance of an `Error`
        expect(context.log.mock.calls[0][0].message).toEqual(message)
        expect(context.res).toEqual({
            body: `Go away, you are not a valid GitHub webhook: Error: ${message}`,
            headers: undefined,
            status: 403
        })
    }

    await expectInvalidWebhook('Unexpected method: GET')

    context.log = jest.fn()
    context.req.method = 'POST'
    context.req.headers = {
        'content-type': 'text/plain'
    }
    await expectInvalidWebhook('Unexpected content type: text/plain')

    context.req.headers['content-type'] = 'application/json'
    await expectInvalidWebhook('Missing X-Hub-Signature')

    context.req.headers['x-hub-signature-256'] = 'invalid'
    await expectInvalidWebhook('Unexpected X-Hub-Signature format: invalid')

    context.req.headers['x-hub-signature-256'] = 'sha256=incorrect'
    context.req.rawBody = '# empty'
    await expectInvalidWebhook('Incorrect X-Hub-Signature')
})

let mockGetInstallationAccessToken = jest.fn(() => 'installation-access-token')
jest.mock('../GitForWindowsHelper/get-installation-access-token', () => {
    return mockGetInstallationAccessToken
})

let mockGitHubApiRequestAsApp = jest.fn()
jest.mock('../GitForWindowsHelper/github-api-request-as-app', () => {
    return mockGitHubApiRequestAsApp
})

const dispatchedWorkflows = []
let mockGitHubApiRequest = jest.fn((_context, _token, method, requestPath, payload) => {
    if (method === 'POST' && requestPath.endsWith('/comments')) return {
        id: -124,
        html_url: `new-comment-url-${payload.body}`
    }
    if (method === 'GET' && requestPath.endsWith('/comments/0')) return {
        body: `existing comment body`
    }
    if (method === 'PATCH' && requestPath.endsWith('/comments/0')) return {
        id: 0,
        html_url: `appended-comment-body-${payload.body}`
    }
    if (method === 'POST' && requestPath.endsWith('/reactions')) return {
        id: `new-reaction-${payload.content}`
    }
    if (method === 'POST' && requestPath === '/graphql') {
        if (payload.query.startsWith('query CollaboratorPermission')) return {
            data: {
                repository:{
                    collaborators: {
                        edges: [{ permission: 'WRITE'}]
                    }
                }
            }
        }
    }
    let match
    if (method === 'POST' && (match = requestPath.match(/([^/]+)\/dispatches$/))) {
        dispatchedWorkflows.unshift({
            html_url: `dispatched-workflow-${match[1]}`,
            path: `.github/workflows/${match[1]}`,
            payload
        })
        return {
            headers: {
                date: (new Date()).toISOString()
            }
        }
    }
    if (method === 'GET' && requestPath.indexOf('/actions/runs?') > 0) return {
        workflow_runs: dispatchedWorkflows
    }
    if (method === 'GET' && requestPath === '/user') return {
        login: 'cheers'
    }
    if (method === 'GET' && requestPath.endsWith('/pulls/86')) return {
        head: { sha: '707a11ee' }
    }
    if (method === 'GET' && requestPath.endsWith('/pulls/4322')) return {
        head: { sha: 'c8edb521bdabec14b07e9142e48cab77a40ba339' }
    }
    if (method === 'GET' && requestPath.endsWith('/pulls/4328')) return {
        head: { sha: 'this-will-be-rc2' }
    }
    if (method === 'GET' && requestPath.endsWith('/pulls/4323')) return {
        head: { sha: 'dee501d15' }
    }
    throw new Error(`Unhandled ${method}-${requestPath}-${JSON.stringify(payload)}`)
})
jest.mock('../GitForWindowsHelper/github-api-request', () => {
    return mockGitHubApiRequest
})

afterEach(() => {
    jest.clearAllMocks()
    dispatchedWorkflows.splice(0, dispatchedWorkflows.length) // empty the array
})

const makeContext = (body, headers) => {
    const rawBody = JSON.stringify(body)
    const sha256 = crypto.createHmac('sha256', process.env['GITHUB_WEBHOOK_SECRET']).update(rawBody).digest('hex')
    return {
        log: jest.fn(),
        req: {
            body,
            headers: {
                'content-type': 'application/json',
                'x-hub-signature-256': `sha256=${sha256}`,
                ...headers || {}
            },
            method: 'POST',
            rawBody
        }
    }
}

function extend (a, ...list) {
    for (const b of list) {
        for (const key of Object.keys(b)) {
            if (Array.isArray(key[a])) a[key].push(...(Array.isArray(b[key]) ? b[key] : [ b[key] ]))
            if (a[key] !== null && a[key] instanceof Object) extend(a[key], b[key])
            else a[key] = b[key]
        }
    }
    return a
}

const testIssueComment = (comment, bodyExtra_, fn) => {
    if (!fn) {
        fn = bodyExtra_
        bodyExtra_= undefined
    }
    const repo = bodyExtra_?.repository?.name || 'git'
    const number = bodyExtra_?.issue?.number || 0
    const pullOrIssues = bodyExtra_?.issue?.pull_request ? 'pull' : 'issues'
    const context = makeContext(extend({
        action: 'created',
        comment: {
            body: comment,
            html_url: `https://github.com/git-for-windows/${repo}/${pullOrIssues}/${number}`,
            id: 0,
            user: {
                login: 'statler and waldorf'
            }
        },
        installation: {
            id: 123
        },
        issue: {
            number
        },
        repository: {
            name: repo,
            owner: {
                login: 'git-for-windows'
            }
        }
    }, bodyExtra_ ? bodyExtra_ : {}), {
        'x-github-event': 'issue_comment'
    })

    test(`test ${comment}`, async () => {
        try {
            await fn(context)
        } catch (e) {
            context.log.mock.calls.forEach(e => console.log(e[0]))
            throw e;
        }
    })
}

testIssueComment('/hi', async (context) => {
    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: 'I said hi! new-comment-url-Hi @statler and waldorf!',
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(mockGitHubApiRequest).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequest.mock.calls[0].slice(1)).toEqual([
        "installation-access-token",
        "POST",
        "/repos/git-for-windows/git/issues/0/comments",
        {"body": "Hi @statler and waldorf!" }
    ])
})

let mockGetInstallationIDForRepo = jest.fn(() => 'installation-id')
jest.mock('../GitForWindowsHelper/get-installation-id-for-repo', () => {
    return mockGetInstallationIDForRepo
})

let mockSearchIssues = jest.fn(() => [])
jest.mock('../GitForWindowsHelper/search', () => {
    return {
        searchIssues: mockSearchIssues
    }
})

testIssueComment('/open pr', {
    issue: {
        number: 4281,
        title: '[New gnutls version] GnuTLS 3.8.0',
        body: `Released a bug-fix and enhancement release on the 3.8.x branch.[GnuTLS 3.8.0](https://lists.gnupg.org/pipermail/gnutls-help/2023-February/004816.html)

Added the security advisory.[GNUTLS-SA-2020-07-14](security-new.html#GNUTLS-SA-2020-07-14)

http://www.gnutls.org/news.html#2023-02-10`
    }
}, async (context) => {
    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: `I edited the comment: appended-comment-body-existing comment body

The MINGW workflow run [was started](dispatched-workflow-open-pr.yml)`,
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(dispatchedWorkflows).toHaveLength(2)
    expect(dispatchedWorkflows.map(e => e.payload.inputs.package)).toEqual(['mingw-w64-gnutls', 'gnutls'])
    expect(mockGitHubApiRequest).toHaveBeenCalled()
    const msysComment = mockGitHubApiRequest.mock.calls[mockGitHubApiRequest.mock.calls.length - 6]
    expect(msysComment[3]).toEqual('/repos/git-for-windows/git/issues/comments/0')
    expect(msysComment[4]).toEqual({
        body: `existing comment body

The MSYS workflow run [was started](dispatched-workflow-open-pr.yml)`
    })
    const mingwComment = mockGitHubApiRequest.mock.calls[mockGitHubApiRequest.mock.calls.length - 1]
    expect(mingwComment[3]).toEqual('/repos/git-for-windows/git/issues/comments/0')
    expect(mingwComment[4]).toEqual({
        body: `existing comment body

The MINGW workflow run [was started](dispatched-workflow-open-pr.yml)`
    })
})

let mockQueueCheckRun = jest.fn(() => 'check-run-id')
let mockUpdateCheckRun = jest.fn()
let mockListCheckRunsForCommit = jest.fn((_context, _token, _owner, _repo, rev, checkRunName) => {
    if (rev === 'this-will-be-rc2') {
        const output = {
            title: 'Build Git -rc2 artifacts',
            summary: 'Build Git -rc2 artifacts from commit this-will-be-rc2 (tag-git run #987)'
        }
        if (checkRunName === 'git-artifacts-x86_64') return [{ id: 8664, status: 'completed', conclusion: 'success', output }]
        if (checkRunName === 'git-artifacts-i686') return [{ id: 686, status: 'completed', conclusion: 'success', output }]
    }
    if (rev === 'dee501d15') {
        if (checkRunName === 'tag-git') return [{
            status: 'completed',
            conclusion: 'success',
            html_url: '<url-to-tag-git',
            output: {
                title: 'Tag Git -rc1½',
                summary: `Tag Git -rc1½ @${rev}`,
                text: 'For details, see [this run](https://github.com/git-for-windows/git-for-windows-automation/actions/runs/341).'
            }
        }]
        return []
    }
    if (checkRunName === 'git-artifacts-x86_64') return [{
        status: 'completed',
        conclusion: 'success',
        html_url: '<url-to-existing-x86_64-run>',
        output: {
            title: 'Build Git -rc1',
            summary: 'Build Git -rc1 from commit c8edb521bdabec14b07e9142e48cab77a40ba339 (tag-git run #4322343196)'
        }
    }]
    return []
})
jest.mock('../GitForWindowsHelper/check-runs', () => {
    return {
        queueCheckRun: mockQueueCheckRun,
        updateCheckRun: mockUpdateCheckRun,
        listCheckRunsForCommit: mockListCheckRunsForCommit
    }
})

testIssueComment('/deploy', {
    issue: {
        number: 86,
        title: 'gnutls: update to 3.8.0',
        body: 'This closes https://github.com/git-for-windows/git/issues/4281',
        pull_request: {
            html_url: 'https://github.com/git-for-windows/MSYS2-packages/pull/86'
        }
    },
    repository: {
        name: 'MSYS2-packages',
    }
}, async (context) => {
    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: `I edited the comment: appended-comment-body-existing comment body

The [x86_64](dispatched-workflow-build-and-deploy.yml) and the [i686](dispatched-workflow-build-and-deploy.yml) workflow runs were started.`,
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(mockQueueCheckRun).toHaveBeenCalledTimes(2)
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    expect(dispatchedWorkflows).toHaveLength(2)
    expect(dispatchedWorkflows.map(e => e.payload.inputs.architecture)).toEqual(['i686', 'x86_64'])
})

testIssueComment('/add release note', {
    issue: {
        number: 4281,
        labels: [{ name: 'component-update' }],
        title: '[New gnutls version] GnuTLS 3.8.0',
        body: `Released a bug-fix and enhancement release on the 3.8.x branch.[GnuTLS 3.8.0](https://lists.gnupg.org/pipermail/gnutls-help/2023-February/004816.html)

Added the security advisory.[GNUTLS-SA-2020-07-14](security-new.html#GNUTLS-SA-2020-07-14)

http://www.gnutls.org/news.html#2023-02-10`
    }
}, async (context) => {
    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: `I edited the comment: appended-comment-body-existing comment body

The workflow run [was started](dispatched-workflow-add-release-note.yml)`,
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(dispatchedWorkflows).toHaveLength(1)
    expect(dispatchedWorkflows[0].payload.inputs).toEqual({
        message: 'Comes with [GNU TLS v3.8.0](https://lists.gnupg.org/pipermail/gnutls-help/2023-February/004816.html).',
        type: 'feature'
    })
})

test('a completed `tag-git` run triggers `git-artifacts` runs', async () => {
    const context = makeContext({
        action: 'completed',
        check_run: {
            name: 'tag-git',
            head_sha: 'c8edb521bdabec14b07e9142e48cab77a40ba339',
            conclusion: 'success',
            output: {
                title: 'Tag Git v2.40.0-rc1.windows.1 @c8edb521bdabec14b07e9142e48cab77a40ba339',
                summary: 'Tag Git v2.40.0-rc1.windows.1 @c8edb521bdabec14b07e9142e48cab77a40ba339',
                text: 'For details, see [this run](https://github.com/git-for-windows/git-for-windows-automation/actions/runs/4322343196).\nTagged Git v2.40.0-rc1.windows.1\nDone!.'
            }
        },
        installation: {
            id: 123
        },
        repository: {
            name: 'git',
            owner: {
                login: 'git-for-windows'
            },
            full_name: 'git-for-windows/git'
        }
    }, {
        'x-github-event': 'check_run'
    })

    try {
        expect(await index(context, context.req)).toBeUndefined()
        expect(context.res).toEqual({
            body: `git-artifacts-x86_64 run already exists at <url-to-existing-x86_64-run>.
The \`git-artifacts-i686\` workflow run [was started](dispatched-workflow-git-artifacts.yml).
`,
            headers: undefined,
            status: undefined
        })
        expect(mockGitHubApiRequest).toHaveBeenCalled()
        expect(mockGitHubApiRequest.mock.calls[0].slice(1)).toEqual([
            'installation-access-token',
            'POST',
            '/repos/git-for-windows/git-for-windows-automation/actions/workflows/git-artifacts.yml/dispatches', {
                ref: 'main',
                inputs: {
                    architecture: 'i686',
                    tag_git_workflow_run_id: 4322343196
                }
            }
        ])
    } catch (e) {
        context.log.mock.calls.forEach(e => console.log(e[0]))
        throw e;
    }
})

testIssueComment('/git-artifacts', {
    issue: {
        number: 4322,
        title: 'Rebase to v2.40.0-rc1',
        pull_request: {
            html_url: 'https://github.com/git-for-windows/git/pull/4322'
        }
    }
}, async (context) => {
    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: `I edited the comment: appended-comment-body-existing comment body

The \`tag-git\` workflow run [was started](dispatched-workflow-tag-git.yml)`,
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(dispatchedWorkflows).toHaveLength(1)
    expect(dispatchedWorkflows[0].html_url).toEqual('dispatched-workflow-tag-git.yml')
    expect(dispatchedWorkflows[0].payload.inputs).toEqual({
        owner: 'git-for-windows',
        repo: 'git',
        rev: 'c8edb521bdabec14b07e9142e48cab77a40ba339',
        snapshot: 'false'
    })

    jest.clearAllMocks()
    dispatchedWorkflows.splice(0, dispatchedWorkflows.length) // empty the array

    // with existing `tag-git` run
    context.req.body.issue = {
        number: 4323,
        title: 'Rebase to v2.40.0-rc1½',
        pull_request: {
            html_url: 'https://github.com/git-for-windows/git/pull/4323'
        }
    }

    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: `I edited the comment: appended-comment-body-existing comment body

The \`git-artifacts-x86_64\` workflow run [was started](dispatched-workflow-git-artifacts.yml).
The \`git-artifacts-i686\` workflow run [was started](dispatched-workflow-git-artifacts.yml).
`,
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalled()
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(dispatchedWorkflows).toHaveLength(2)
    expect(dispatchedWorkflows[0].html_url).toEqual('dispatched-workflow-git-artifacts.yml')
    expect(dispatchedWorkflows[0].payload.inputs).toEqual({
        architecture: 'i686',
        tag_git_workflow_run_id: 341
    })
    expect(dispatchedWorkflows[1].html_url).toEqual('dispatched-workflow-git-artifacts.yml')
    expect(dispatchedWorkflows[1].payload.inputs).toEqual({
        architecture: 'x86_64',
        tag_git_workflow_run_id: 341
    })
})

testIssueComment('/release', {
    issue: {
        number: 4328,
        title: 'Rebase to v2.40.0-rc2',
        pull_request: {
            html_url: 'https://github.com/git-for-windows/git/pull/4328'
        }
    }
}, async (context) => {
    expect(await index(context, context.req)).toBeUndefined()
    expect(context.res).toEqual({
        body: `I edited the comment: appended-comment-body-existing comment body

The \`release-git\` workflow run [was started](dispatched-workflow-release-git.yml)`,
        headers: undefined,
        status: undefined
    })
    expect(mockGetInstallationAccessToken).toHaveBeenCalledTimes(1)
    expect(mockGitHubApiRequestAsApp).not.toHaveBeenCalled()
    expect(dispatchedWorkflows).toHaveLength(1)
    expect(dispatchedWorkflows[0].html_url).toEqual('dispatched-workflow-release-git.yml')
    expect(dispatchedWorkflows[0].payload.inputs).toEqual({
        git_artifacts_x86_64_workflow_run_id: 8664,
        git_artifacts_i686_workflow_run_id: 686
    })
})
