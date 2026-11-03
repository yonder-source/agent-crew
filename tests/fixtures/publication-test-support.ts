import type { CandidateSubmissionRecord } from '../../src/publication/candidates.js';
import type { StateFixture } from './state-fixture.js';

export function recordConfirmedPublication(
  fixture: StateFixture,
  candidate: CandidateSubmissionRecord,
  pullRequestNumber = 17,
): string {
  const job = fixture.jobs.get(candidate.jobId);
  if (!job) throw new Error('Create the candidate job before publication evidence');
  const operationId = `published-pr-${candidate.candidateId}`;
  const taskBranch = `agent/${candidate.jobId}`;
  const target = {
    repositoryId: candidate.repositoryId,
    taskBranch,
    candidateSha: candidate.candidateSha,
  };
  fixture.effects.begin({
    operationId,
    jobId: job.jobId,
    operationKind: 'publication_pull_request',
    arguments: { candidateSha: candidate.candidateSha, pullRequestNumber },
    target,
    expectedJobVersion: job.rowVersion,
    scopeRevisionId: candidate.scopeRevisionId,
    policyVersion: candidate.policyVersion,
    callerIdentity: 'controller:publication',
    grant: { action: 'publication_pull_request' },
    steps: [{ stepId: `${operationId}:write`, stepKey: 'write', target }],
    writerGeneration: 1,
  });
  const stepId = `${operationId}:write`;
  if (!fixture.effects.claimStepStart(operationId, stepId, 1)) throw new Error('Could not claim publication test effect');
  const step = fixture.effects.get(operationId)?.steps[0];
  if (!step) throw new Error('Publication test effect is missing');
  fixture.effectResults.recordResult({
    operationId,
    stepId,
    expectedStepVersion: step.rowVersion,
    status: 'confirmed_success',
    result: {
      authoritative: true,
      branchHead: candidate.candidateSha,
      pullRequest: {
        number: pullRequestNumber,
        headSha: candidate.candidateSha,
        baseBranch: 'main',
        state: 'open',
        jobMarker: candidate.jobId,
      },
    },
    resultGeneration: 1,
    resultSource: 'provider_receipt',
    writerGeneration: 1,
  });
  fixture.database.prepare(`
    INSERT INTO publication_bindings (
      job_id, repository_id, task_branch, base_branch, pull_request_number, initial_candidate_id, bound_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(candidate.jobId, candidate.repositoryId, taskBranch, 'main', pullRequestNumber,
    candidate.candidateId, fixture.state.now().toISOString());
  return operationId;
}
