import { describe, expect, it } from 'vitest';
import { countTarget } from '../../src/ui/countTarget.ts';

function doc(scheme: string, text: string) {
  return {
    uri: { scheme },
    getText(range?: unknown) {
      return range ? (range as { text: string }).text : text;
    },
  };
}

describe('countTarget', () => {
  it('returns undefined for schemes other than the supported ones', () => {
    expect(countTarget(doc('output', 'x'), [{ isEmpty: true }])).toBeUndefined();
  });

  it('accepts every supported scheme', () => {
    for (const scheme of ['file', 'untitled', 'vscode-notebook-cell', 'vscode-remote', 'vscode-userdata']) {
      expect(countTarget(doc(scheme, 'x'), [{ isEmpty: true }])).toBeDefined();
    }
  });

  it('counts the whole document for an empty selection', () => {
    expect(countTarget(doc('file', 'full text'), [{ isEmpty: true }])).toEqual({
      what: 'document',
      texts: ['full text'],
    });
  });

  it('counts the whole document when there are no selections', () => {
    expect(countTarget(doc('file', 'full text'), [])).toEqual({ what: 'document', texts: ['full text'] });
  });

  it('returns the texts of non-empty selections', () => {
    const sel = [
      { isEmpty: false, text: 'a' },
      { isEmpty: false, text: 'b' },
    ];
    expect(countTarget(doc('file', 'full'), sel)).toEqual({ what: 'selection', texts: ['a', 'b'] });
  });

  it('ignores empty selections when others are non-empty', () => {
    const sel = [{ isEmpty: true }, { isEmpty: false, text: 'b' }];
    expect(countTarget(doc('file', 'full'), sel)).toEqual({ what: 'selection', texts: ['b'] });
  });
});
