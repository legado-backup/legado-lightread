import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// Exercise the real scheduler with controllable native synthesis and playback.
const state = {
  settings: { ttsEngine: 'local', localVoiceId: 50, ttsRate: 1, ttsVoice: '' },
  synthesize: () => Promise.resolve(new Blob(['wav'])),
  played: [],
  spoken: [],
  notices: [],
}
globalThis.__ttsTest = state
globalThis.speechSynthesis = {
  cancel() {}, pause() {}, resume() {},
  getVoices: () => [{ name: 'system', lang: 'zh-CN' }],
  speak(utterance) { state.spoken.push(utterance.text); utterance.onend() },
}
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text }
}

const ttsUrl = new URL('../src/services/tts.ts', import.meta.url).href
const modules = {
  '../stores/settings': 'export const useSettings = () => globalThis.__ttsTest.settings',
  './toast': 'export const toast = (...args) => globalThis.__ttsTest.notices.push(args)',
  '../i18n': 'export const t = key => key',
  './localTts': `export const localTtsAvailable = () => true;
    export const localTtsSynthesize = (...args) => globalThis.__ttsTest.synthesize(...args)`,
  './edgeTts': `export const edgeAvailable = () => false;
    export const edgePause = () => {};
    export const edgeResume = () => {};
    export const edgeStop = () => {};
    export const edgeSynthesize = () => { throw new Error('unexpected Edge call') };
    export const playAudio = async blob => { globalThis.__ttsTest.played.push(blob); return 'end' }`,
}
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ttsUrl && modules[specifier]) {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(modules[specifier])}` }
    }
    return nextResolve(specifier, context)
  },
})
const { speakText, stopSpeech, resetEdgeFailure } = await import(ttsUrl)
hook.deregister()

function reset() {
  stopSpeech()
  resetEdgeFailure()
  state.played.length = 0
  state.spoken.length = 0
  state.notices.length = 0
}

test('plays a completed offline synthesis', async () => {
  reset()
  state.synthesize = async () => new Blob(['wav'])
  assert.equal(await speakText('hello'), 'end')
  assert.equal(state.played.length, 1)
})

test('stop during offline synthesis prevents late playback', async () => {
  reset()
  const pending = Promise.withResolvers()
  state.synthesize = () => pending.promise
  const speech = speakText('old paragraph')
  stopSpeech()
  pending.resolve(new Blob(['old']))
  assert.equal(await speech, 'cancelled')
  assert.equal(state.played.length, 0)
  assert.equal(state.spoken.length, 0)
})

test('a stopped failure does not fall back or poison a new session', async () => {
  reset()
  const pending = Promise.withResolvers()
  state.synthesize = () => pending.promise
  const old = speakText('old paragraph')
  stopSpeech()
  pending.reject(new Error('cancelled session failed'))
  assert.equal(await old, 'cancelled')
  assert.equal(state.notices.length, 0)
  assert.equal(state.spoken.length, 0)
  state.synthesize = async () => new Blob(['new'])
  assert.equal(await speakText('new paragraph'), 'end')
  assert.equal(state.played.length, 1)
})

test('new playback survives completion of an older cancelled synthesis', async () => {
  reset()
  const pending = Promise.withResolvers()
  state.synthesize = () => pending.promise
  const old = speakText('old paragraph')
  stopSpeech()
  state.synthesize = async () => new Blob(['new'])
  assert.equal(await speakText('new paragraph'), 'end')
  pending.resolve(new Blob(['old']))
  assert.equal(await old, 'cancelled')
  assert.equal(state.played.length, 1)
  assert.equal(await state.played[0].text(), 'new')
})
