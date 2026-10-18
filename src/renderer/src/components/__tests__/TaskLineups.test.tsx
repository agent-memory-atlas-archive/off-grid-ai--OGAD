// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskLineups } from '../TaskLineups'
import type { TaskRolesView } from '../../../../shared/task-roles-view'

afterEach(cleanup)

const view = (modelId: string, modelName: string): TaskRolesView => ({
  badges: {},
  tasks: [
    {
      task: 'computer_use',
      taskLabel: 'Computer Use',
      strategyLabel: 'Grounded',
      slots: [
        {
          role: 'grounding_specialist',
          label: 'Grounding specialist',
          does: 'Finds what to click on screen',
          modelId,
          modelName,
          remote: false
        }
      ]
    }
  ]
})

const models = [
  { id: 'ui-tars-1.5-7b', name: 'UI-TARS-1.5-7B', kind: 'computer_use', grounder: true },
  { id: 'ui-mate-9b', name: 'UI-Mate-9B', kind: 'computer_use', grounder: true }
]

describe('<TaskLineups/>', () => {
  it('names a not-downloaded specialist plainly and offers to fetch it', () => {
    render(
      <TaskLineups
        view={view('ui-tars-1.5-7b', 'UI-TARS-1.5-7B')}
        models={models}
        installed={['ui-mate-9b']}
      />
    )
    // The name stays clean; the status says it is not here; the card is the button to fetch it.
    expect(screen.getByText('UI-TARS-1.5-7B')).toBeTruthy()
    expect(screen.getByText('Not downloaded')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download UI-TARS-1.5-7B' })).toBeTruthy()
  })

  it('names a downloaded active model plainly', () => {
    render(
      <TaskLineups
        view={view('ui-mate-9b', 'UI-Mate-9B')}
        models={models}
        installed={['ui-mate-9b']}
      />
    )
    expect(screen.getByText('UI-Mate-9B')).toBeTruthy()
    expect(screen.queryByText(/not downloaded/)).toBeNull()
  })

  it('unloads the grounding specialist and switches it from the dropdown, like every other slot', async () => {
    // Main, faked at the IPC line: Unload frees the role's runtime; the role setter records the pick.
    const unloaded: string[] = []
    const picked: string[] = []
    ;(window as unknown as { api: unknown }).api = {
      unloadRuntime: async (role: string) => {
        unloaded.push(role)
        return true
      },
      setTaskRole: async (_task: string, _role: string, modelId: string) => {
        picked.push(modelId)
      }
    }
    const user = userEvent.setup()
    render(
      <TaskLineups
        view={view('ui-mate-9b', 'UI-Mate-9B')}
        models={models}
        installed={['ui-mate-9b', 'ui-tars-1.5-7b']}
      />
    )
    const slot = screen.getByRole('region', { name: 'Computer Use Grounding specialist' })
    const card = within(slot).getByLabelText('Computer Use Grounding specialist active model')
    expect(card.textContent).toContain('UI-Mate-9B')
    expect(card.textContent).not.toContain('Unloaded')

    await user.click(within(slot).getByRole('button', { name: 'Unload' }))
    await waitFor(() => expect(card.textContent).toContain('Unloaded'))
    expect(unloaded).toEqual(['grounding'])

    // The dropdown offers the other installed specialist, not the active one again.
    await user.click(within(slot).getByRole('combobox', { name: 'Computer Use Grounding specialist' }))
    expect(screen.queryByRole('option', { name: 'UI-Mate-9B' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'UI-TARS-1.5-7B' }))
    await waitFor(() => expect(picked).toEqual(['ui-tars-1.5-7b']))
  })
})
