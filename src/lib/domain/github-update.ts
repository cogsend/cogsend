import workflow from './github-update-workflow.yml?raw';

/**
 * Updating a Deploy-button install through its own GitHub repository: the
 * repository's "Update CogSend" Action installs a release and Workers Builds
 * deploys it, so no Cloudflare token is involved (scripts/lib/github-update.mjs
 * has the checks it runs).
 *
 * The button cannot copy workflow files into the repository it creates, so the
 * Action arrives through GitHub's new-file page, with the name and contents
 * filled in: one "Commit changes" by the operator.
 */
export const GITHUB_UPDATE_WORKFLOW: string = workflow;

const WORKFLOW_PATH = '.github/workflows/update.yml';
const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w./-]+$/;

export type GithubUpdateTarget = { repo: string; branch: string };

/** The repository a button install was deployed from, as its deploy script
 *  recorded it (COGSEND_REPO, COGSEND_BRANCH), or null when unknown. */
export function githubUpdateTarget(
	repo: string | null | undefined,
	branch: string | null | undefined
): GithubUpdateTarget | null {
	if (!repo || !REPO.test(repo)) return null;
	return { repo, branch: branch && BRANCH.test(branch) ? branch : 'main' };
}

export function githubUpdateLinks({ repo, branch }: GithubUpdateTarget) {
	return {
		/** The Action's page, with its Run workflow button. */
		run: `https://github.com/${repo}/actions/workflows/update.yml`,
		/** GitHub's new-file page with the workflow filled in, for the first time. */
		enable:
			`https://github.com/${repo}/new/${branch}` +
			`?filename=${encodeURIComponent(WORKFLOW_PATH)}&value=${encodeURIComponent(GITHUB_UPDATE_WORKFLOW)}`,
		/** The workflow file's editor, to paste a newer version over it: GitHub
		 *  lets no Action rewrite its own workflow. */
		edit: `https://github.com/${repo}/edit/${branch}/${WORKFLOW_PATH}`,
		/** Where the AUTO_UPDATE repository variable is created. */
		variables: `https://github.com/${repo}/settings/variables/actions/new`
	};
}
