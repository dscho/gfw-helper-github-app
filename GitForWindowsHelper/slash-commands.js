const { activeOrg } = require('./org')

module.exports = async (context, req) => {
    const command = req.body.comment.body
    const owner = req.body.repository.owner.login
    const repo = req.body.repository.name
    const issueNumber = req.body.issue.number
    const commenter = req.body.comment.user.login
    let commentId = req.body.comment.id
    let commentURL = req.body.comment.html_url

    context.log(`Looking at command '${command}' (${typeof command})`)

    if (command === '/hi') {
        const comment = `Hi @${commenter}!`

        const getInstallationAccessToken = require('./get-installation-access-token')
        const token = await getInstallationAccessToken(context, req.body.installation.id)

        const { addIssueComment } = require('./issues')
        const answer = await addIssueComment(context, token, owner, repo, issueNumber, comment)

        return `I said hi! ${answer.html_url}`
    }

    const getToken = (() => {
        let token

        const get = async () => {
            const getInstallationIdForRepo = require('./get-installation-id-for-repo')
            const installationId = await getInstallationIdForRepo(context, owner, repo)
            const getInstallationAccessToken = require('./get-installation-access-token')
            return await getInstallationAccessToken(context, installationId)
        }

        return async () => token || (token = await get())
    })()

    const checkPermissions = async () => {
        const getCollaboratorPermissions = require('./get-collaborator-permissions')
        const token = await getToken()
        const permission = await getCollaboratorPermissions(context, token, owner, repo, commenter)
        if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission.toString())) throw new Error(`@${commenter} has no permissions to do that`)
    }

    const react = async (reaction) => {
        const { createReactionForIssueComment } = require('./issues')
        await createReactionForIssueComment(console, await getToken(), owner, repo, commentId, reaction)
    }

    const thumbsUp = async () => react('+1')

    try {
        if (command == '/open pr') {
            if (owner !== activeOrg || repo !== 'git') return `Ignoring ${command} in unexpected repo: ${commentURL}`

            await checkPermissions()

            const { guessComponentUpdateDetails, packageNeedsBothMSYSAndMINGW } = require('./component-updates')
            const { package_name, version } = guessComponentUpdateDetails(req.body.issue.title, req.body.issue.body)

            await thumbsUp()

            const openPR = async (package_name, packageType) => {
                const { searchIssues } = require('./search')
                const prTitle = `${package_name}: update to ${version}`
                const items = await searchIssues(context, `org:${activeOrg} is:pull-request "${prTitle}" in:title`)
                const alreadyOpenedPR = items.filter(e => e.title === prTitle)

                const { appendToIssueComment } = require('./issues');
                if (alreadyOpenedPR.length > 0) {
                    ({ html_url: commentURL, id: commentId } =
                      await appendToIssueComment(
                          context,
                          await getToken(),
                          owner,
                          repo,
                          commentId,
                          `${
                              packageType ? `${packageType} ` : ""
                          }PR [already exists](${alreadyOpenedPR[0].html_url})`
                      ));
                    return
                }

                const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
                const answer = await triggerWorkflowDispatch(
                    context,
                    await getToken(),
                    activeOrg,
                    'git-for-windows-automation',
                    'open-pr.yml',
                    'main', {
                        package: package_name,
                        version,
                        actor: commenter
                    }
                );
                ({ html_url: commentURL, id: commentId } = await appendToIssueComment(context, await getToken(), owner, repo, commentId, `The${packageType ? ` ${packageType}` : ''} workflow run [was started](${answer.html_url})`))
            }
            if (!packageNeedsBothMSYSAndMINGW(package_name)) {
                await openPR(package_name)
            } else {
                await openPR(package_name, 'MSYS')
                await openPR(`mingw-w64-${package_name}`, 'MINGW')
            }
            return `I edited the comment: ${commentURL}`
        }

        if (command == '/updpkgsums') {
            if (owner !== activeOrg
             || !req.body.issue.pull_request
             || !['build-extra', 'MINGW-packages', 'MSYS2-packages'].includes(repo)) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            await checkPermissions()
            await thumbsUp()

            const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
            const answer = await triggerWorkflowDispatch(
                context,
                await getToken(),
                activeOrg,
                'git-for-windows-automation',
                'updpkgsums.yml',
                'main', {
                    repo,
                    'pr-number': issueNumber,
                    actor: commenter
                }
            );
            const { appendToIssueComment } = require('./issues');
            ({ html_url: commentURL } = await appendToIssueComment(context, await getToken(), owner, repo, commentId, `The workflow run [was started](${answer.html_url}).`))

            return `I edited the comment: ${commentURL}`
        }

        const deployMatch = command.match(/^\/deploy(\s+(\S+)\s*)?$/)
        if (deployMatch) {
            if (owner !== activeOrg
             || !req.body.issue.pull_request
             || !['build-extra', 'MINGW-packages', 'MSYS2-packages'].includes(repo)) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            await checkPermissions()

            const { guessComponentUpdateDetails, isMSYSPackage, needsSeparateARM64Build } = require('./component-updates')
            const { package_name } = deployMatch[2]
                ? { package_name: deployMatch[2] }
                : guessComponentUpdateDetails(req.body.issue.title, req.body.issue.body)

            // The commit hash of the tip commit is sadly not part of the
            // "comment.created" webhook's payload. Therefore, we have to get it
            // "by hand"
            const { getPRCommitSHAAndTargetBranch } = require('./issues')
            const { sha: ref } = await getPRCommitSHAAndTargetBranch(console, await getToken(), owner, repo, issueNumber)

            await thumbsUp()

            const { queueCheckRun, updateCheckRun } = require('./check-runs')
            const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
            const triggerBuild = async (architecture) =>
                await triggerWorkflowDispatch(
                    context,
                    await getToken(),
                    activeOrg,
                    'git-for-windows-automation',
                    'build-and-deploy.yml',
                    'main', {
                        package: package_name,
                        repo,
                        ref,
                        architecture,
                        actor: commenter
                    }
                )

            const { appendToIssueComment } = require('./issues')
            const appendToComment = async (text) =>
                await appendToIssueComment(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    commentId,
                    text
                )

            const toTrigger = []
            if (isMSYSPackage(package_name)) {
                if (package_name !== 'msys2-runtime-3.3' && !req.body.issue.title.startsWith('i686:')) {
                    toTrigger.push(
                        { architecture: 'x86_64' }
                    )
                }

                if (package_name !== 'msys2-runtime') {
                    toTrigger.push(
                        { architecture: 'i686' }
                    )
                }
            } else {
                if (package_name !== 'mingw-w64-clang') {
                    toTrigger.push(
                        { displayArchitecture: 'i686/x86_64' }
                    )
                }
                if (needsSeparateARM64Build(package_name)) {
                    toTrigger.push(
                        { architecture: 'aarch64', displayArchitecture: 'arm64' }
                    )
                }
            }

            for (const e of toTrigger) {
                const deployLabel = e.architecture ? `deploy_${e.architecture}` : 'deploy'
                e.id = await queueCheckRun(
                    context,
                    await getToken(),
                    activeOrg,
                    repo,
                    ref,
                    deployLabel,
                    `Build and deploy ${package_name}`,
                    `Deploying ${package_name}`
                )
            }

            for (const e of toTrigger) {
                e.answer = await triggerBuild(e.architecture)
            }

            const answer = await appendToComment(
                toTrigger.length === 1
                    ? `The workflow run [was started](${toTrigger[0].answer.html_url}).`
                    : `${toTrigger.map((e, index) => {
                        return `${
                            index === 0 ? 'The' : index === toTrigger.length - 1 ? ' and the' : ', the'
                        } [${
                            e.displayArchitecture || e.architecture
                        }](${
                            e.answer.html_url
                        })`
                    }).join('')} workflow runs were started.`
            )

            for (const e of toTrigger) {
                await updateCheckRun(
                    context,
                    await getToken(),
                    activeOrg,
                    repo,
                    e.id, {
                        details_url: e.answer.html_url
                    }
                )
            }

            return `I edited the comment: ${answer.html_url}`
        }

        const gitArtifactsCommandMatch = command.match(`^/(min)?git-artifacts(?: --release-date=(.*))?$`)
        if (gitArtifactsCommandMatch) {
            if (owner !== activeOrg
             || repo !== 'git'
             || !req.body.issue.pull_request
            ) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            const mingitOnly = gitArtifactsCommandMatch[1] === 'min'
            const releaseDate = gitArtifactsCommandMatch[2]

            await checkPermissions()
            await thumbsUp()

            const { getPRCommitSHAAndTargetBranch } = require('./issues')
            const { sha: rev, targetBranch: releaseBranch } = await getPRCommitSHAAndTargetBranch(context, await getToken(), owner, repo, issueNumber)

            const { wasWorkflowRunDeleted } = require('./workflow-runs')
            const workflowRunExists = async url => {
                const match = url.match(`^https://github.com/${owner}/([^/]+)/actions/runs/([0-9]+)`)
                if (!match) return false
                const [, repo, runId] = match
                return !(await wasWorkflowRunDeleted(
                    context,
                    await getToken(owner, repo),
                    owner,
                    repo,
                    runId
                ))
            }

            const { listCheckRunsForCommit, queueCheckRun, updateCheckRun } = require('./check-runs')
            const runs = releaseDate ? [] : await listCheckRunsForCommit(
                context,
                await getToken(owner, repo),
                owner,
                repo,
                rev,
                'tag-git'
            )
            const latest = runs
                .sort((a, b) => a.id - b.id)
                .pop()
            if (
                latest
                && latest.status === 'completed'
                && latest.conclusion === 'success'
                && await workflowRunExists(latest.details_url)
            ) {
                // There is already a `tag-git` workflow run; Trigger the `git-artifacts` runs directly
                if (!latest.head_sha) latest.head_sha = rev
                const { triggerGitArtifactsRuns } = require('./cascading-runs')
                const res = await triggerGitArtifactsRuns(context, owner, repo, latest, mingitOnly)

                const { appendToIssueComment } = require('./issues')
                const answer2 = await appendToIssueComment(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    commentId,
                    res
                )
                return `I edited the comment: ${answer2.html_url}`
            }

            const tagGitCheckRunTitle = `Tag ${mingitOnly ? 'Min' : ''}Git @${rev}`
            const tagGitCheckRunId = await queueCheckRun(
                context,
                await getToken(),
                owner,
                repo,
                rev,
                'tag-git',
                tagGitCheckRunTitle,
                tagGitCheckRunTitle
            )

            try {
                const inputs = {
                    rev,
                    owner,
                    repo,
                    snapshot: 'false',
                }
                if (releaseBranch !== 'main') inputs['release-branch'] = releaseBranch
                if (mingitOnly) inputs['mingit-only'] = 'true'
                if (releaseDate) inputs['release-date'] = releaseDate
                const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
                const answer = await triggerWorkflowDispatch(
                    context,
                    await getToken(),
                    activeOrg,
                    'git-for-windows-automation',
                    'tag-git.yml',
                    'main',
                    inputs
                )

                const { appendToIssueComment } = require('./issues')
                const answer2 = await appendToIssueComment(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    commentId,
                    `The \`tag-git\` workflow run [was started](${answer.html_url})`
                )
                return `I edited the comment: ${answer2.html_url}`
            } catch (e) {
                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    tagGitCheckRunId, {
                        status: 'completed',
                        conclusion: 'failure',
                        output: {
                            title: tagGitCheckRunTitle,
                            summary: tagGitCheckRunTitle,
                            text: e.message || JSON.stringify(e, null, 2)
                        }
                    }
                )
                throw e
            }
        }

        if (command === '/release') {
            if (owner !== 'git-for-windows'
              || repo !== 'git'
              || !req.body.issue.pull_request
            ) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            await checkPermissions()
            await thumbsUp()

            // Find the `git-artifacts` runs' IDs
            const { getPRCommitSHAAndTargetBranch } = require('./issues')
            const { sha: commitSHA } = await getPRCommitSHAAndTargetBranch(context, await getToken(), owner, repo, issueNumber)

            const { listCheckRunsForCommit, queueCheckRun, updateCheckRun } = require('./check-runs')
            const checkRunTitle = `Publish Git for Windows @${commitSHA}`
            const checkRunSummary = `Downloading the Git artifacts from the 'git-artifacts' runs and publishing them as a new GitHub Release at ${owner}/${repo}`
            const releaseCheckRunId = await queueCheckRun(
                context,
                await getToken(),
                activeOrg,
                repo,
                commitSHA,
                'github-release',
                checkRunTitle,
                checkRunSummary
            )

            try {
                let gitVersion
                let tagGitWorkflowRunID
                const workFlowRunIDs = {}
                for (const architecture of ['x86_64', 'i686']) {
                    const workflowName = `git-artifacts-${architecture}`
                    const runs = await listCheckRunsForCommit(
                        context,
                        await getToken(owner, repo),
                        owner,
                        repo,
                        commitSHA,
                        workflowName
                    )
                    const latest = runs
                        .filter(run => run.output.summary.indexOf(` from commit ${commitSHA} ` > 0))
                        .sort((a, b) => a.id - b.id)
                        .pop()
                    if (latest) {
                        if (latest.status !== 'completed' || latest.conclusion !== 'success') {
                            throw new Error(`The '${workflowName}}' run at ${latest.html_url} did not succeed.`)
                        }

                        const match = latest.output.text.match(/For details, see \[this run\]\(https:\/\/github.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\)/)
                        if (!match) throw new Error(`Unhandled 'text' attribute of git-artifacts run ${latest.id}: ${latest.url}`)
                        const owner = match[1]
                        const repo = match[2]
                        workFlowRunIDs[architecture] = match[3]
                        if (owner !== activeOrg || repo !== 'git-for-windows-automation') {
                            throw new Error(`Unexpected repository ${owner}/${repo} for git-artifacts run ${latest.id}: ${latest.url}`)
                        }

                        const gitVersionMatch = latest.output.summary.match(/^Build Git (\S+) artifacts from commit (\S+) \(tag-git run #(\d+)\)$/)
                        if (!gitVersionMatch) throw new Error(`Could not parse summary '${latest.output.summary}' of run ${latest.id}`)
                        if (!gitVersion) gitVersion = gitVersionMatch[1]
                        else if (gitVersion !== gitVersionMatch[1]) throw new Error(`The 'git-artifacts' runs disagree on the Git version`)
                        if (!tagGitWorkflowRunID) tagGitWorkflowRunID = gitVersionMatch[3]
                        else if (tagGitWorkflowRunID !== gitVersionMatch[3]) throw new Error(`The 'git-artifacts' runs are based on different 'tag-git' runs`)
                    } else {
                        throw new Error(`The '${workflowName}' run was not found`)
                    }
                }

                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    releaseCheckRunId, {
                        output: {
                            title: `Publish ${gitVersion} for @${commitSHA}`,
                            summary: `Downloading the Git artifacts from ${workFlowRunIDs['x86_64']} and ${workFlowRunIDs['i686']} and publishing them as a new GitHub Release at ${owner}/${repo}`
                        }
                    }
                )

                const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
                const answer = await triggerWorkflowDispatch(
                    context,
                    await getToken(),
                    activeOrg,
                    'git-for-windows-automation',
                    'release-git.yml',
                    'main', {
                        git_artifacts_x86_64_workflow_run_id: workFlowRunIDs['x86_64'],
                        git_artifacts_i686_workflow_run_id: workFlowRunIDs['i686']
                    }
                )

                const { appendToIssueComment } = require('./issues')
                const answer2 = await appendToIssueComment(context, await getToken(), owner, repo, commentId, `The \`release-git\` workflow run [was started](${answer.html_url})`)
                return `I edited the comment: ${answer2.html_url}`
            } catch (e) {
                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    releaseCheckRunId, {
                        status: 'completed',
                        conclusion: 'failure',
                        output: {
                            title: checkRunTitle,
                            summary: checkRunSummary,
                            text: e.message || JSON.stringify(e, null, 2)
                        }
                    }
                )
                throw e
            }
        }

        if (command === '/prepare-embargoed-release') {
            if (owner !== activeOrg
              || repo !== 'git'
              || !req.body.issue.pull_request
            ) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            await checkPermissions()
            await thumbsUp()

            // Find the `git-artifacts` runs' IDs
            const { getPRCommitSHAAndTargetBranch } = require('./issues')
            const { sha: commitSHA } = await getPRCommitSHAAndTargetBranch(context, await getToken(), owner, repo, issueNumber)

            const { listCheckRunsForCommit, queueCheckRun, updateCheckRun } = require('./check-runs')
            const checkRunTitle = `Prepare embargoed Git for Windows @${commitSHA}`
            const checkRunSummary = `Downloading the Git artifacts from and publishing them as a new embargoed GitHub Release at ${owner}/${repo}`
            const releaseCheckRunId = await queueCheckRun(
                context,
                await getToken(),
                activeOrg,
                repo,
                commitSHA,
                'prepare-github-release',
                checkRunTitle,
                checkRunSummary
            )

            try {
                let gitVersion
                let tagGitWorkflowRunID
                const workFlowRunIDs = {}
                for (const architecture of ['x86_64', 'i686']) {
                    const workflowName = `git-artifacts-${architecture}`
                    const runs = await listCheckRunsForCommit(
                        context,
                        await getToken(owner, repo),
                        owner,
                        repo,
                        commitSHA,
                        workflowName
                    )
                    const latest = runs
                        .filter(run => run.output.summary.indexOf(` from commit ${commitSHA} ` > 0))
                        .sort((a, b) => a.id - b.id)
                        .pop()
                    if (latest) {
                        if (latest.status !== 'completed' || latest.conclusion !== 'success') {
                            throw new Error(`The '${workflowName}}' run at ${latest.html_url} did not succeed.`)
                        }

                        const match = latest.output.text.match(/For details, see \[this run\]\(https:\/\/github.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\)/)
                        if (!match) throw new Error(`Unhandled 'text' attribute of git-artifacts run ${latest.id}: ${latest.url}`)
                        const owner = match[1]
                        const repo = match[2]
                        workFlowRunIDs[architecture] = match[3]
                        if (owner !== activeOrg || repo !== 'git-for-windows-automation') {
                            throw new Error(`Unexpected repository ${owner}/${repo} for git-artifacts run ${latest.id}: ${latest.url}`)
                        }

                        const gitVersionMatch = latest.output.summary.match(/^Build Git (\S+) artifacts from commit (\S+) \(tag-git run #(\d+)\)$/)
                        if (!gitVersionMatch) throw new Error(`Could not parse summary '${latest.output.summary}' of run ${latest.id}`)
                        if (!gitVersion) gitVersion = gitVersionMatch[1]
                        else if (gitVersion !== gitVersionMatch[1]) throw new Error(`The 'git-artifacts' runs disagree on the Git version`)
                        if (!tagGitWorkflowRunID) tagGitWorkflowRunID = gitVersionMatch[3]
                        else if (tagGitWorkflowRunID !== gitVersionMatch[3]) throw new Error(`The 'git-artifacts' runs are based on different 'tag-git' runs`)
                    } else {
                        throw new Error(`The '${workflowName}' run was not found`)
                    }
                }

                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    releaseCheckRunId, {
                        output: {
                            title: `Prepare embargoed ${gitVersion} for @${commitSHA}`,
                            summary: `Downloading the Git artifacts from ${workFlowRunIDs['x86_64']} and ${workFlowRunIDs['i686']} and publishing them as a new embargoed GitHub Release at ${owner}/${repo}`
                        }
                    }
                )

                const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
                const answer = await triggerWorkflowDispatch(
                    context,
                    await getToken(),
                    activeOrg,
                    'git-for-windows-automation',
                    'prepare-embargoed-release.yml',
                    'main', {
                        git_artifacts_x86_64_workflow_run_id: workFlowRunIDs['x86_64'],
                        git_artifacts_i686_workflow_run_id: workFlowRunIDs['i686']
                    }
                )

                const { appendToIssueComment } = require('./issues')
                const answer2 = await appendToIssueComment(context, await getToken(), owner, repo, commentId, `The \`prepare-embargoed-release\` workflow run [was started](${answer.html_url})`)
                return `I edited the comment: ${answer2.html_url}`
            } catch (e) {
                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    releaseCheckRunId, {
                        status: 'completed',
                        conclusion: 'failure',
                        output: {
                            title: checkRunTitle,
                            summary: checkRunSummary,
                            text: e.message || JSON.stringify(e, null, 2)
                        }
                    }
                )
                throw e
            }
        }

        if (command === '/publish-embargoed-release') {
            if (owner !== activeOrg
              || repo !== 'git'
              || !req.body.issue.pull_request
            ) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            await checkPermissions()
            await thumbsUp()

            // Find the `git-artifacts` runs' IDs
            const { getPRCommitSHAAndTargetBranch } = require('./issues')
            const { sha: commitSHA } = await getPRCommitSHAAndTargetBranch(context, await getToken(), owner, repo, issueNumber)

            const { listCheckRunsForCommit, queueCheckRun, updateCheckRun } = require('./check-runs')
            const checkRunTitle = `Publish embargoed Git for Windows @${commitSHA}`
            const checkRunSummary = `Downloading the Git artifacts from the embargoed-builds GitHub Release and publishing them as a new GitHub Release at git-for-windows/${repo}`
            const releaseCheckRunId = await queueCheckRun(
                context,
                await getToken(),
                activeOrg,
                repo,
                commitSHA,
                'github-release',
                checkRunTitle,
                checkRunSummary
            )

            try {
                let gitVersion
                const workflowName = `tag-git`
                const runs = await listCheckRunsForCommit(
                    context,
                    await getToken(owner, repo),
                    owner,
                    repo,
                    commitSHA,
                    workflowName
                )
                const latest = runs
                    .filter(run => run.output.summary.indexOf(` from commit ${commitSHA} ` > 0))
                    .sort((a, b) => a.id - b.id)
                    .pop()
                if (latest) {
                    if (latest.status !== 'completed' || latest.conclusion !== 'success') {
                        throw new Error(`The '${workflowName}}' run at ${latest.html_url} did not succeed.`)
                    }

                    const match = latest.output.text.match(/Tagged (?:Min)?Git (v\d+\S+)/)
                    if (!match) throw new Error(`Unhandled 'text' attribute of tag-git run ${latest.id}: ${latest.url}`)
                    gitVersion = match[1]
                } else {
                    throw new Error(`The '${workflowName}' run was not found`)
                }

                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    releaseCheckRunId, {
                        output: {
                            title: `Publish embargoed ${gitVersion} for @${commitSHA}`,
                            summary: checkRunSummary
                        }
                    }
                )

                const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
                const answer = await triggerWorkflowDispatch(
                    context,
                    await getToken(),
                    activeOrg,
                    'git-for-windows-automation',
                    'publish-embargoed-release.yml',
                    'main', {
                        'git-version': gitVersion
                    }
                )

                const { appendToIssueComment } = require('./issues')
                const answer2 = await appendToIssueComment(context, await getToken(), owner, repo, commentId, `The \`publish-embargoed-release\` workflow run [was started](${answer.html_url})`)
                return `I edited the comment: ${answer2.html_url}`
            } catch (e) {
                await updateCheckRun(
                    context,
                    await getToken(),
                    owner,
                    repo,
                    releaseCheckRunId, {
                        status: 'completed',
                        conclusion: 'failure',
                        output: {
                            title: checkRunTitle,
                            summary: checkRunSummary,
                            text: e.message || JSON.stringify(e, null, 2)
                        }
                    }
                )
                throw e
            }
        }

        const relNotesMatch = command.match(/^\/add (relnote|release ?note)(\s+(blurb|feature|bug)\s+([^]*))?$/i)
        if (relNotesMatch) {
            if (owner !== activeOrg
             || !['git', 'build-extra', 'MINGW-packages', 'MSYS2-packages'].includes(repo)) {
                return `Ignoring ${command} in unexpected repo: ${commentURL}`
            }

            await checkPermissions()

            const { appendToIssueComment } = require('./issues')
            let [ , , , type, message ] = relNotesMatch
            if (!type) {
                const { guessReleaseNotes, getMissingDeployments } = require('./component-updates');
                let package_name, version
                ({ type, message, package: package_name, version } = await guessReleaseNotes(context, req.body.issue))
                const missingDeployments = await getMissingDeployments(package_name, version)
                if (missingDeployments.length > 0) {
                    const message = `The following deployment(s) are missing:\n\n* ${missingDeployments.join('\n* ')}`
                    await appendToIssueComment(context, await getToken(), owner, repo, commentId, message)
                    throw new Error(message)
                }
            }

            await thumbsUp()

            const triggerWorkflowDispatch = require('./trigger-workflow-dispatch')
            const answer = await triggerWorkflowDispatch(
                context,
                await getToken(),
                activeOrg,
                'build-extra',
                'add-release-note.yml',
                'main', {
                    type,
                    message
                }
            )
            const answer2 = await appendToIssueComment(context, await getToken(), owner, repo, commentId, `The workflow run [was started](${answer.html_url})`)
            return `I edited the comment: ${answer2.html_url}`
        }
    } catch (e) {
        await react('confused')
        throw e
    }

    return `Ignoring slash command ${command} in ${commentURL}`
}
