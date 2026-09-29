import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'

export function useHermesModels(args: {
    api: ApiClient; sessionId?: string; machineId?: string | null; cwd?: string;
    enabled: boolean; model?: string | null
}) {
    const refresh = useRef(false)
    const query = useQuery({
        queryKey: args.sessionId
            ? ['session-hermes-models', args.sessionId, args.model]
            : ['machine-hermes-models', args.machineId, args.cwd],
        queryFn: async () => {
            const force = refresh.current
            refresh.current = false
            return args.sessionId
                ? await args.api.getSessionHermesModels(args.sessionId, force)
                : await args.api.getMachineHermesModels(args.machineId!, args.cwd!, force)
        },
        enabled: args.enabled,
        staleTime: 30_000,
        retry: false
    })
    return {
        availableModels: query.data?.availableModels ?? [],
        currentModelId: query.data?.currentModelId ?? null,
        isLoading: query.isFetching,
        error: query.error?.message ?? (query.data?.success === false ? query.data.error ?? 'Hermes model discovery failed' : null),
        refetch: () => {
            if (!args.enabled) return
            refresh.current = true
            void query.refetch()
        }
    }
}
