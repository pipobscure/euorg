<!--
  AppShell — shared chrome wrapper used by all four apps.

  Slots:
    header   — top toolbar / titlebar area
    sidebar  — left panel (optional)
    children — main scrollable content area (required)

  All apps should mount inside this shell so they share
  the same structural conventions and baseline chrome.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		header?: Snippet;
		sidebar?: Snippet;
		children: Snippet;
	}

	let { header, sidebar, children }: Props = $props();
</script>

<div class="app-shell preset-filled-surface-50-950 flex h-screen flex-col overflow-hidden">
	{#if header}
		<header class="border-b border-surface-200-800 shrink-0">
			{@render header()}
		</header>
	{/if}

	<div class="flex flex-1 overflow-hidden">
		{#if sidebar}
			<aside class="border-r border-surface-200-800 shrink-0 overflow-y-auto">
				{@render sidebar()}
			</aside>
		{/if}

		<main class="flex-1 flex flex-col overflow-hidden">
			{@render children()}
		</main>
	</div>
</div>
