(async () => {
    const fs = require('fs')

    const localSettings = JSON.parse(fs.readFileSync('local.settings.json'))
    process.env.GITHUB_APP_ID = localSettings.Values.GITHUB_APP_ID
    process.env.GITHUB_APP_PRIVATE_KEY = localSettings.Values.GITHUB_APP_PRIVATE_KEY

    const sha256 = text => {
        const crypto = require('crypto')
        return crypto.createHash('sha256').update(text).digest('hex')
    }

    const gitHubRequestAsApp = require('./GitForWindowsHelper/github-api-request-as-app')
    const answer = await gitHubRequestAsApp(console, 'GET', '/app/installations?per_page=100')
    for (const e of answer.filter(e =>
        e.account.login !== 'git-for-windows' &&
        e.account.login !== 'dscho' &&
	sha256(e.account.login) !== 'c84dfa28e1830ba79dfc165165e328999ba448aedfe92517c00b0005cea10c82'
    )) {
        console.log(`Deleting installation ${e.id} for ${e.account.login}`)
        await gitHubRequestAsApp(console, 'DELETE', `/app/installations/${e.id}`)
    }
})().catch(console.log)