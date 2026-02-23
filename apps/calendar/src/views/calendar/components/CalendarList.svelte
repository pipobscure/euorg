<script lang="ts">
	import type { CalendarView, AccountView } from "../lib/types.ts";

	interface Props {
		calendars: CalendarView[];
		accounts: AccountView[];
		onToggle: (calendarId: string, enabled: boolean) => void;
		onSettingsClick: () => void;
	}

	let { calendars, accounts, onToggle, onSettingsClick }: Props = $props();

	// Group calendars by account
	const calendarsByAccount = $derived.by(() => {
		const groups = new Map<string, CalendarView[]>();
		for (const cal of calendars) {
			const existing = groups.get(cal.accountId) ?? [];
			existing.push(cal);
			groups.set(cal.accountId, existing);
		}
		return groups;
	});
</script>

<div class="flex flex-1 w-52 flex-col text-sm">
	<!-- Calendar groups -->
	<div class="flex-1 overflow-y-auto py-3 px-2">
		{#if calendars.length === 0}
			<div class="px-2 py-4 text-center text-xs text-surface-500-400">
				<p>No calendars.</p>
				<button onclick={onSettingsClick} class="mt-1 text-primary-500 hover:underline">
					Add an account
				</button>
			</div>
		{/if}

		{#each accounts as account (account.id)}
			{@const accountCals = calendarsByAccount.get(account.id) ?? []}
			{#if accountCals.length > 0}
				<div class="mb-3">
					<div class="mb-1 px-2 text-xs font-semibold text-surface-500-400 uppercase tracking-wider truncate">
						{account.name}
					</div>
					{#each accountCals as cal (cal.id)}
						<label class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-100-900">
							<input
								type="checkbox"
								checked={cal.enabled}
								onchange={(e) => onToggle(cal.id, (e.target as HTMLInputElement).checked)}
								class="sr-only"
							/>
							<!-- Custom colored checkbox -->
							<span
								class="flex size-4 shrink-0 items-center justify-center rounded border-2 transition-colors"
								style="border-color: {cal.color}; background-color: {cal.enabled ? cal.color : 'transparent'};"
							>
								{#if cal.enabled}
									<svg class="size-3 text-white" viewBox="0 0 12 12" fill="currentColor">
										<path d="M3.5 6.5L5.5 8.5L8.5 4.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
									</svg>
								{/if}
							</span>
							<span class="truncate text-surface-900-100">{cal.name}</span>
						{#if cal.readonly}
							<svg class="size-3 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor" title="Read-only">
								<path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd"/>
							</svg>
						{/if}
						</label>
					{/each}
				</div>
			{/if}
		{/each}
	</div>

	<!-- Settings button -->
	<div class="border-t border-surface-200-800 px-2 py-2">
		<button
			onclick={onSettingsClick}
			class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-surface-600-400 hover:bg-surface-100-900 hover:text-surface-900-100 transition-colors"
		>
			<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clip-rule="evenodd"/>
			</svg>
			Settings
		</button>
	</div>
</div>
