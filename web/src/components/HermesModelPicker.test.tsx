import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HermesModelPicker, groupHermesModels } from './HermesModelPicker'

vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const models = [
    { modelId: 'custom:office:qwen:32b', name: 'qwen:32b', providerLabel: 'Office' },
    { modelId: 'custom:home:qwen:32b', name: 'qwen:32b', providerLabel: 'Home' }
]

describe('Hermes provider model picker', () => {
    it('groups and searches providers without collapsing identical model names', () => {
        expect(groupHermesModels(models, 'qwen').map(([label]) => label)).toEqual(['Home', 'Office'])
        const change = vi.fn()
        render(<HermesModelPicker models={models} value={models[0].modelId} onChange={change} onRefresh={() => {}} />)
        fireEvent.change(screen.getByLabelText('hermes.models.search'), { target: { value: 'home' } })
        fireEvent.click(screen.getByRole('button', { name: /custom:home:qwen:32b/ }))
        expect(change).toHaveBeenCalledWith('custom:home:qwen:32b')
        expect(screen.queryByRole('button', { name: /custom:office:qwen:32b/ })).toBeNull()
    })
    it('keeps refresh and manual/default creation available after discovery errors', () => {
        const change = vi.fn(), refresh = vi.fn()
        render(<HermesModelPicker models={models} value="auto" onChange={change} onRefresh={refresh} allowDefault error="offline" />)
        expect(screen.getByRole('alert').textContent).toBe('offline')
        expect(screen.getByRole('button', { name: /custom:home:qwen:32b/ })).toBeDisabled()
        fireEvent.click(screen.getByText('hermes.models.refresh'))
        expect(refresh).toHaveBeenCalledOnce()
        fireEvent.change(screen.getByLabelText('newSession.model'), { target: { value: 'custom:other:model' } })
        expect(change).toHaveBeenCalledWith('custom:other:model')
    })
})
