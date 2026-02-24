<script lang="ts">
	import type { VCard, ContactRow, Account, Collection } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	interface Props {
		card: VCard;
		row: ContactRow;
		accounts: Account[];
		collections: Collection[];
		onMenu: (x: number, y: number) => void;
	}

	let { card, row, accounts, collections, onMenu }: Props = $props();

	function openLink(e: MouseEvent, url: string) {
		e.preventDefault();
		rpc.request.openExternal({ url });
	}

	function formatBirthday(iso: string): string {
		if (!iso) return "";
		try {
			return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		} catch {
			return iso;
		}
	}

	function formatAddress(adr: VCard["addresses"][0]): string {
		return [adr.street, adr.city, adr.region, adr.postcode, adr.country]
			.filter(Boolean)
			.join(", ");
	}

	function addressMapUrl(adr: VCard["addresses"][0]): string {
		if (adr.geoLat != null && adr.geoLon != null) {
			const lat = adr.geoLat, lon = adr.geoLon;
			return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
		}
		const q = formatAddress(adr);
		return `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`;
	}

	let currentAccount = $derived(accounts.find((a) => a.id === row.accountId));
	let currentCollection = $derived(collections.find((c) => c.id === row.collectionId));
</script>

<div
	class="flex h-full flex-col overflow-y-auto p-6"
	oncontextmenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
>
	<!-- Header: avatar + name + menu button -->
	<div class="mb-6 flex items-start gap-4">
		{#if card.photo}
			<img src={card.photo} alt={card.fn} class="h-16 w-16 rounded-full object-cover" />
		{:else}
			<div class="bg-primary-500/20 text-primary-600-300 flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-bold">
				{card.fn?.[0]?.toUpperCase() ?? "?"}
			</div>
		{/if}
		<div class="flex-1 min-w-0">
			<h2 class="text-xl font-semibold">{card.fn}</h2>
			{#if card.org || card.title}
				<p class="text-surface-400 text-sm">
					{[card.title, card.org].filter(Boolean).join(" · ")}
				</p>
			{/if}
		</div>
		<!-- Collection origin + menu button -->
		<div class="flex shrink-0 items-center gap-1">
			<span class="text-surface-400 text-xs">
				{currentCollection?.name ?? row.collectionId}{currentAccount ? " · " + currentAccount.name : ""}
			</span>
			<button
				class="text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 rounded p-1 text-lg leading-none"
				onclick={(e) => { e.stopPropagation(); onMenu(e.clientX, e.clientY); }}
				title="More actions"
				aria-label="More actions"
			>⋮</button>
		</div>
	</div>

	<!-- Fields -->
	<div class="space-y-4 text-sm">
		{#if card.emails.length > 0}
			<section>
				<h3 class="text-surface-400 mb-1 text-xs font-semibold uppercase tracking-wider">Email</h3>
				{#each card.emails as email}
					<div class="flex items-center gap-2">
						<a href="mailto:{email.value}" class="text-primary-500 hover:underline"
							onclick={(e) => openLink(e, `mailto:${email.value}`)}>{email.value}</a>
						{#if email.type}
							<span class="text-surface-400 text-xs capitalize">{email.type}</span>
						{/if}
					</div>
				{/each}
			</section>
		{/if}

		{#if card.phones.length > 0}
			<section>
				<h3 class="text-surface-400 mb-1 text-xs font-semibold uppercase tracking-wider">Phone</h3>
				{#each card.phones as phone}
					<div class="flex items-center gap-2">
						<a href="tel:{phone.value.replace(/\s+/g, '')}" class="hover:text-primary-500"
							onclick={(e) => openLink(e, `tel:${phone.value.replace(/\s+/g, '')}`)}>{phone.value}</a>
						{#if phone.type}
							<span class="text-surface-400 text-xs capitalize">{phone.type}</span>
						{/if}
					</div>
				{/each}
			</section>
		{/if}

		{#if card.addresses.length > 0}
			<section>
				<h3 class="text-surface-400 mb-1 text-xs font-semibold uppercase tracking-wider">Address</h3>
				{#each card.addresses as adr}
					<div class="flex items-start gap-2">
						<a
							href={addressMapUrl(adr)}
							class="text-primary-500 hover:underline"
							onclick={(e) => openLink(e, addressMapUrl(adr))}
						>{formatAddress(adr)}</a>
						{#if adr.type}
							<span class="text-surface-400 text-xs capitalize">{adr.type}</span>
						{/if}
					</div>
				{/each}
			</section>
		{/if}

		{#if card.birthday}
			<section>
				<h3 class="text-surface-400 mb-1 text-xs font-semibold uppercase tracking-wider">Birthday</h3>
				<div>{formatBirthday(card.birthday)}</div>
			</section>
		{/if}

		{#if card.note}
			<section>
				<h3 class="text-surface-400 mb-1 text-xs font-semibold uppercase tracking-wider">Notes</h3>
				<div class="text-surface-600-300 whitespace-pre-wrap">{card.note}</div>
			</section>
		{/if}

	</div>
</div>
