import { describe, expect, it } from 'vitest'
import { taskRolesView } from '../task-roles-view'

const model = (
  role: 'reasoner' | 'decision' | 'grounding_specialist',
  modelId: string,
  remote = false
) => ({
  role,
  modelId,
  modelName: modelId,
  remote
})

describe('taskRolesView', () => {
  it('lines up the models each task runs together, and names what each one does', () => {
    const view = taskRolesView({
      computerUse: {
        strategy: 'decision_plus_specialist',
        strategyLabel: 'Decision + Reasoning + Specialist',
        models: [
          model('decision', 'kev-4b'),
          model('reasoner', 'gemini', true),
          model('grounding_specialist', 'ui-tars', true)
        ]
      },
      webUse: {
        strategy: 'decision_plus_reasoning',
        strategyLabel: 'Decision + Reasoning',
        models: [model('decision', 'jev', true), model('reasoner', 'gemini', true)]
      }
    })
    expect(view.tasks.map((t) => [t.taskLabel, t.slots.map((s) => s.label)])).toEqual([
      ['Web Use', ['Decision model', 'Reasoner']],
      ['Computer Use', ['Decision model', 'Reasoner', 'Grounding specialist']]
    ])
    expect(view.badges).toEqual({
      jev: 'Decision model · Web Use',
      gemini: 'Reasoner · Web Use and Computer Use',
      'kev-4b': 'Decision model · Computer Use',
      'ui-tars': 'Grounding specialist · Computer Use'
    })
  })
})
