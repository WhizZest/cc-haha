import { describe, expect, test } from 'bun:test'
import {
  OPENAI_DEFAULT_MAIN_MODEL,
  isOpenAIResponsesModel,
  resolveOpenAICodexModel,
} from './models.js'

describe('openai auth model resolution', () => {
  test('does not treat opus as an OpenAI Responses model', () => {
    expect(isOpenAIResponsesModel('opus')).toBe(false)
  })

  test('accepts gpt and o-series models', () => {
    expect(isOpenAIResponsesModel('gpt-5.4')).toBe(true)
    expect(isOpenAIResponsesModel('o3-mini')).toBe(true)
  })

  test('maps opus aliases to the OpenAI default model', () => {
    expect(resolveOpenAICodexModel('opus')).toBe(OPENAI_DEFAULT_MAIN_MODEL)
  })
})
