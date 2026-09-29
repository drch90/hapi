import { useId, useMemo, useState } from 'react'
import type { HermesModelSummary } from '@hapi/protocol'
import { useTranslation } from '@/lib/use-translation'

export function groupHermesModels(models: readonly HermesModelSummary[], search: string): Array<[string, HermesModelSummary[]]> {
    const groups = new Map<string, HermesModelSummary[]>()
    const query = search.trim().toLowerCase()
    for (const model of models) {
        if (![model.modelId, model.name, model.providerLabel].some(value => value?.toLowerCase().includes(query))) continue
        const group = model.providerLabel ?? 'Hermes'
        groups.set(group, [...(groups.get(group) ?? []), model])
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

export function HermesModelPicker(props: {
    models: HermesModelSummary[]; value: string | null; onChange: (value: string) => void;
    isLoading?: boolean; error?: string | null; disabled?: boolean; allowDefault?: boolean; onRefresh: () => void
}) {
    const { t } = useTranslation()
    const [search, setSearch] = useState('')
    const id = useId()
    const groups = useMemo(() => groupHermesModels(props.models, search), [props.models, search])
    const selected = props.models.find(model => model.modelId === props.value)
    return <div className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
            <span className="text-xs break-all">{selected ? `${selected.providerLabel ? `${selected.providerLabel} · ` : ''}${selected.name ?? selected.modelId}` : props.value && props.value !== 'auto' ? props.value : t('hermes.models.default')}</span>
            <button type="button" disabled={props.disabled || props.isLoading} onClick={props.onRefresh} className="text-xs text-[var(--app-link)]">{t('hermes.models.refresh')}</button>
        </div>
        <input aria-label={t('hermes.models.search')} placeholder={t('hermes.models.search')} value={search} onChange={event => setSearch(event.target.value)}
            className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
        {props.isLoading ? <p role="status" className="text-xs">{t('hermes.models.loading')}</p> : null}
        {props.error ? <p role="alert" className="text-xs text-red-500">{props.error}</p> : null}
        <div className="max-h-48 overflow-y-auto">
            {props.allowDefault ? <button type="button" disabled={props.disabled} onClick={() => props.onChange('auto')} className="w-full py-2 text-left text-sm">{t('hermes.models.default')}</button> : null}
            {groups.map(([provider, models]) => <div key={provider}>
                <div className="sticky top-0 bg-[var(--app-bg)] py-1 text-xs font-semibold text-[var(--app-hint)]">{provider}</div>
                {models.map(model => <button key={model.modelId} type="button" aria-pressed={props.value === model.modelId}
                    disabled={props.disabled || props.isLoading || Boolean(props.error)} onClick={() => props.onChange(model.modelId)}
                    className={`block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 ${props.value === model.modelId ? 'text-[var(--app-link)]' : ''}`}>
                    <span className="block">{model.name ?? model.modelId}</span>
                    <span className="block break-all text-xs text-[var(--app-hint)]">{model.modelId}</span>
                </button>)}
            </div>)}
            {!props.isLoading && !props.error && groups.length === 0 ? <p className="text-xs text-[var(--app-hint)]">{t('hermes.models.empty')}</p> : null}
        </div>
        {props.allowDefault ? <div>
            <label htmlFor={id} className="text-xs">{t('newSession.model')}</label>
            <input id={id} value={props.value === 'auto' ? '' : props.value ?? ''} disabled={props.disabled}
                placeholder={t('newSession.hermes.modelPlaceholder')} onChange={event => props.onChange(event.target.value || 'auto')}
                className="w-full rounded border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
        </div> : null}
    </div>
}
