/**
 * Check if PR targets the correct branch (develop)
 * and post comments/labels accordingly
 */
module.exports = async ({ github, context, core }) => {
  const targetBranch = context.payload.pull_request.base.ref;
  const expectedBranch = 'develop';
  const prAuthor = context.payload.pull_request.user.login;
  const prNumber = context.payload.pull_request.number;

  // Check if user is a collaborator
  let isCollaborator = false;
  try {
    const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username: prAuthor
    });
    // Collaborators have 'admin', 'write', or 'maintain' permission
    isCollaborator = ['admin', 'write', 'maintain'].includes(permission.permission);
    console.log(`User ${prAuthor} permission level: ${permission.permission}`);
  } catch (error) {
    console.log(`User ${prAuthor} is not a collaborator (${error.message})`);
    isCollaborator = false;
  }

  if (targetBranch !== expectedBranch) {
    console.log(`❌ PR is targeting '${targetBranch}' instead of '${expectedBranch}'`);

    // Only comment for non-collaborators
    if (!isCollaborator) {
      const comment = `## ⚠️ Incorrect Target Branch

Hi @${prAuthor}! 👋

Thank you for your contribution! However, we noticed that this PR is targeting the \`${targetBranch}\` branch.

**All pull requests should target the \`${expectedBranch}\` branch.**

### How to fix this:

1. You can change the target branch by clicking the "Edit" button next to the PR title
2. Select \`${expectedBranch}\` as the base branch
3. Or close this PR and create a new one targeting \`${expectedBranch}\`

Please update the target branch to \`${expectedBranch}\` before we can review your changes. Thank you! 🙏`;

      // Post comment
      try {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: comment
        });
        console.log(`💬 Comment posted for non-collaborator ${prAuthor}`);
      } catch (error) {
        console.log(`⚠️ Failed to post comment: ${error.message}`);
        console.log(`This might be due to insufficient permissions. Error status: ${error.status}`);
      }
    } else {
      console.log(`⏭️ Skipping comment for collaborator ${prAuthor}`);
    }

    // Add label for all wrong-target PRs (collaborators or not)
    try {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        labels: ['wrong-target-branch']
      });
      console.log(`🏷️ Added 'wrong-target-branch' label`);
    } catch (error) {
      console.log(`⚠️ Failed to add label: ${error.message}`);
    }

    // Set check to failed
    core.setFailed(`PR is targeting '${targetBranch}' instead of '${expectedBranch}'`);
  } else {
    console.log(`✅ PR is correctly targeting the '${expectedBranch}' branch`);

    // Remove the label if it was previously added
    try {
      await github.rest.issues.removeLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: prNumber,
        name: 'wrong-target-branch'
      });
      console.log(`🏷️ Removed 'wrong-target-branch' label`);
    } catch (error) {
      // Label might not exist, which is fine
      if (error.status === 404) {
        console.log(`ℹ️ Label 'wrong-target-branch' was not present`);
      } else {
        console.log(`⚠️ Could not remove label: ${error.message}`);
      }
    }
  }
};
