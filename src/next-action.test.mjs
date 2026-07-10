import assert from 'node:assert/strict';
import test from 'node:test';

import * as nextActionModule from './next-action.mjs';
import {
  AUTO_ALLOWLIST,
  classifyTag,
  governNextAction,
  isNextAction,
} from './next-action.mjs';

test('consequential or irreversible actions are gated to the human', () => {
  const consequential = governNextAction({
    target: 'Change a standing weekly commitment.',
    risk: 'consequential',
    reversibilityClass: 'internal-revertible',
    authority: 'human',
  });
  const irreversible = governNextAction({
    target: 'Delete an external account.',
    risk: 'low-stakes',
    reversibility: 'irreversible',
    authority: 'human',
  });

  assert.equal(consequential.tag, '[gate:human]');
  assert.equal(consequential.status, 'requires-human-gate');
  assert.equal(irreversible.tag, '[gate:human]');
  assert.equal(irreversible.status, 'requires-human-gate');
});

test('reversible low-stakes actions are advisory only', () => {
  const action = governNextAction({
    target: 'Review the saved attention-recovery bookmarks.',
    risk: 'low-stakes',
    'reversibility-class': 'internal-revertible',
    authority: 'human',
  });

  assert(isNextAction(action));
  assert.equal(action.tag, '[advise]');
  assert.equal(action.status, 'advisory-only');
  assert.equal(action.unattended, false);
});

test('nothing is ever tagged auto while the auto allowlist is empty', () => {
  const actions = [
    governNextAction({
      target: 'Review a note.',
      risk: 'low-stakes',
      reversibilityClass: 'internal-revertible',
      authority: 'human',
      tag: '[auto]',
    }),
    governNextAction({
      target: 'Send an external message.',
      risk: 'consequential',
      reversibilityClass: 'external-cancelable',
      authority: 'human',
    }),
  ];

  assert.deepEqual(AUTO_ALLOWLIST, []);
  assert(actions.every((action) => typeof action !== 'object' || action.tag !== '[auto]'));
});

test('[auto] actions are rejected while the auto allowlist is empty', () => {
  const action = {
    kind: 'NextAction',
    schemaVersion: 1,
    target: 'Review a note.',
    risk: 'low-stakes',
    'reversibility-class': 'internal-revertible',
    authority: 'human',
    tag: '[auto]',
    status: 'advisory-only',
    unattended: false,
  };

  assert.deepEqual(AUTO_ALLOWLIST, []);
  assert.equal(isNextAction(action), false);
  assert.equal(
    classifyTag({
      risk: 'low-stakes',
      reversibilityClass: 'internal-revertible',
      target: action.target,
      requestedTag: '[auto]',
    }),
    '[advise]',
  );
});

test('unvalidated actions degrade to inert text and cannot fire', () => {
  const inert = governNextAction({
    target: 'Show a confirmation button.',
    risk: 'low-stakes',
    reversibilityClass: 'internal-revertible',
    recommended: 'Ask the human to confirm.',
  });

  assert.equal(typeof inert, 'string');
  assert.match(inert, /^Inert text:/);
  assert.match(inert, /confirmation is not authority/);
});

test('module exposes no execute or fire capability', () => {
  assert.equal(nextActionModule.execute, undefined);
  assert.equal(nextActionModule.fire, undefined);
  assert.equal(nextActionModule.executeNextAction, undefined);
  assert.equal(nextActionModule.fireNextAction, undefined);
  assert(
    Object.entries(nextActionModule).every(
      ([name, value]) => !/(^|next)(execute|fire)/i.test(name) || typeof value !== 'function',
    ),
  );
});
