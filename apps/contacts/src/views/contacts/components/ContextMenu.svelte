<script lang="ts">
	export interface MenuItem {
		label: string;
		action?: () => void;
		submenu?: MenuItem[];
		separator?: true;
		danger?: boolean;
		disabled?: boolean;
	}

	interface Props {
		x: number;
		y: number;
		items: MenuItem[];
		onClose: () => void;
	}

	let { x, y, items, onClose }: Props = $props();

	let menuEl = $state<HTMLElement | null>(null);
	let activeSubmenuIndex = $state<number | null>(null);

	// Adjust position so menu stays within the viewport
	let adjustedX = $state(x);
	let adjustedY = $state(y);

	$effect(() => {
		if (!menuEl) return;
		const rect = menuEl.getBoundingClientRect();
		adjustedX = x + rect.width > window.innerWidth ? x - rect.width : x;
		adjustedY = y + rect.height > window.innerHeight ? y - rect.height : y;
	});

	function clickItem(item: MenuItem, index: number) {
		if (item.disabled) return;
		if (item.submenu) {
			activeSubmenuIndex = activeSubmenuIndex === index ? null : index;
			return;
		}
		onClose();
		item.action?.();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Backdrop: catches clicks outside the menu -->
<div
	class="fixed inset-0 z-40"
	onclick={onClose}
	oncontextmenu={(e) => { e.preventDefault(); onClose(); }}
></div>

<!-- Menu -->
<div
	bind:this={menuEl}
	class="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-surface-200-800 bg-surface-50 py-1 shadow-xl dark:bg-surface-900"
	style="left: {adjustedX}px; top: {adjustedY}px;"
	onclick={(e) => e.stopPropagation()}
>
	{#each items as item, i}
		{#if item.separator}
			<div class="border-surface-200-800 my-1 border-t"></div>
		{:else}
			<button
				class="flex w-full cursor-default items-center gap-2 px-3 py-1.5 text-left text-sm
					{item.danger ? 'text-error-500 hover:bg-error-500/10' : 'hover:bg-surface-100 dark:hover:bg-surface-800'}
					{item.disabled ? 'opacity-40' : ''}"
				onclick={() => clickItem(item, i)}
				disabled={item.disabled}
			>
				<span class="flex-1">{item.label}</span>
				{#if item.submenu}
					<span class="text-surface-400 text-[10px]">{activeSubmenuIndex === i ? "▾" : "▸"}</span>
				{/if}
			</button>

			<!-- Inline submenu (expands below the parent item on click) -->
			{#if item.submenu && activeSubmenuIndex === i}
				<div class="border-surface-200-800 ml-3 border-l">
					{#each item.submenu as sub}
						<button
							class="flex w-full cursor-default items-center px-3 py-1.5 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-800
								{sub.disabled ? 'opacity-40' : ''}"
							onclick={() => { onClose(); sub.action?.(); }}
							disabled={sub.disabled}
						>
							{sub.label}
						</button>
					{/each}
				</div>
			{/if}
		{/if}
	{/each}
</div>
