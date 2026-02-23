<script lang="ts">
	import type { ContactRow } from "../lib/types.ts";

	interface Props {
		contacts: ContactRow[];
		selectedUid: string | null;
		onselect: (uid: string) => void;
		onsearch: (query: string) => void;
		onContactContextMenu: (uid: string, x: number, y: number) => void;
		onListContextMenu: (x: number, y: number) => void;
	}

	let { contacts, selectedUid, onselect, onsearch, onContactContextMenu, onListContextMenu }: Props = $props();

	// Search input — managed locally; debounced changes are passed up via onsearch
	let query = $state("");
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function onInput() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => onsearch(query), 200);
	}

	// Group contacts alphabetically
	const grouped = $derived(() => {
		const groups = new Map<string, ContactRow[]>();
		for (const c of contacts) {
			const letter = (c.displayName?.[0] ?? "#").toUpperCase();
			const key = /[A-Z]/.test(letter) ? letter : "#";
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(c);
		}
		const sorted = [...groups.keys()].sort((a, b) => {
			if (a === "#") return 1;
			if (b === "#") return -1;
			return a.localeCompare(b);
		});
		return sorted.map((key) => ({ key, items: groups.get(key)! }));
	});

	const letters = $derived(grouped().map((g) => g.key));

	function scrollToLetter(letter: string) {
		document.getElementById(`group-${letter}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Search input -->
	<div class="border-surface-200-800 shrink-0 border-b px-2 py-2">
		<div class="relative">
			<span class="text-surface-400 pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm">🔍</span>
			<input
				id="contact-search"
				class="input w-full pl-8 text-sm"
				type="search"
				placeholder="Search contacts…"
				bind:value={query}
				oninput={onInput}
			/>
		</div>
	</div>

	<!-- List + letter index -->
	<div class="flex flex-1 overflow-hidden">
		<!-- Contact list -->
		<div
			class="flex-1 overflow-y-auto"
			oncontextmenu={(e) => { e.preventDefault(); onListContextMenu(e.clientX, e.clientY); }}
		>
			{#if contacts.length === 0}
				<div class="text-surface-400 flex h-full items-center justify-center text-sm">
					No contacts
				</div>
			{:else}
				{#each grouped() as group}
					<div id="group-{group.key}">
						<div class="bg-surface-100-800 text-surface-500-400 sticky top-0 px-3 py-1 text-xs font-semibold tracking-widest">
							{group.key}
						</div>
						{#each group.items as contact}
							<button
								class="hover:bg-surface-100-800 flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors
									{selectedUid === contact.uid ? 'bg-primary-500/10 border-l-2 border-primary-500' : ''}"
								onclick={() => onselect(contact.uid)}
								oncontextmenu={(e) => {
									e.preventDefault();
									e.stopPropagation();
									onselect(contact.uid);
									onContactContextMenu(contact.uid, e.clientX, e.clientY);
								}}
							>
								<div class="bg-surface-200-700 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
									{contact.displayName?.[0]?.toUpperCase() ?? "?"}
								</div>
								<div class="min-w-0 flex-1">
									<div class="truncate text-sm font-medium">{contact.displayName}</div>
									<div class="text-surface-400 truncate text-xs">
										{contact.org ?? contact.emails[0]?.value ?? contact.phones[0]?.value ?? ""}
									</div>
								</div>
							</button>
						{/each}
					</div>
				{/each}
			{/if}
		</div>

		<!-- Letter index sidebar -->
		{#if letters.length > 1}
			<div class="flex w-5 flex-col items-center justify-center gap-px py-2">
				{#each letters as letter}
					<button
						class="text-surface-400 hover:text-primary-500 w-full cursor-pointer text-center text-[9px] font-medium leading-none"
						onclick={() => scrollToLetter(letter)}
					>
						{letter}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
