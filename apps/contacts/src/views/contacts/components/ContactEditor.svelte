<script lang="ts">
	import type { VCard, VCardInput, Collection } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	interface Props {
		card?: VCard | null; // null = create new
		collections: Collection[];
		defaultCollectionId: string | null;
		currentCollectionId?: string | null; // collection the contact is currently in (edit mode)
		onSave: (uid: string) => void;
		onCancel: () => void;
	}

	let { card = null, collections, defaultCollectionId, currentCollectionId = null, onSave, onCancel }: Props = $props();

	// Form state
	let firstName = $state(card?.firstName ?? "");
	let lastName = $state(card?.lastName ?? "");
	let org = $state(card?.org ?? "");
	let title = $state(card?.title ?? "");
	let birthday = $state(card?.birthday ?? "");
	let note = $state(card?.note ?? "");
	// When editing, start with the contact's current collection; when creating, use default
	let selectedCollectionId = $state((card ? currentCollectionId : null) ?? defaultCollectionId ?? collections[0]?.id ?? "");

	// Multi-value fields
	let emails = $state<Array<{ value: string; type: string }>>(
		card?.emails.length ? card.emails.map((e) => ({ ...e })) : [{ value: "", type: "work" }],
	);
	let phones = $state<Array<{ value: string; type: string }>>(
		card?.phones.length ? card.phones.map((p) => ({ ...p })) : [{ value: "", type: "cell" }],
	);
	let addresses = $state<Array<{ street: string; city: string; region: string; postcode: string; country: string; type: string }>>(
		card?.addresses.length
			? card.addresses.map((a) => ({ ...a }))
			: [],
	);

	const EMAIL_TYPES = ["work", "home", "other"];
	const PHONE_TYPES = ["cell", "work", "home", "voice", "fax", "other"];
	const ADR_TYPES = ["home", "work", "other"];

	function addEmail() { emails = [...emails, { value: "", type: "work" }]; }
	function removeEmail(i: number) { emails = emails.filter((_, idx) => idx !== i); }

	function addPhone() { phones = [...phones, { value: "", type: "cell" }]; }
	function removePhone(i: number) { phones = phones.filter((_, idx) => idx !== i); }

	function addAddress() {
		addresses = [...addresses, { street: "", city: "", region: "", postcode: "", country: "", type: "home" }];
	}
	function removeAddress(i: number) { addresses = addresses.filter((_, idx) => idx !== i); }

	let saving = $state(false);
	let error = $state("");

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.stopPropagation();
			onCancel();
		} else if (e.key === "Enter" && !e.shiftKey && !saving) {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
			e.preventDefault();
			save();
		}
	}

	async function save() {
		saving = true;
		error = "";
		try {
			const input: VCardInput = {
				uid: card?.uid,
				firstName: firstName.trim(),
				lastName: lastName.trim(),
				emails: emails.filter((e) => e.value.trim()),
				phones: phones.filter((p) => p.value.trim()),
				addresses: addresses.filter((a) => a.street || a.city || a.country),
				org: org.trim() || undefined,
				title: title.trim() || undefined,
				birthday: birthday || undefined,
				note: note.trim() || undefined,
			};

			const vcf: string = await rpc.request.serializeVCard({ input });

			if (card) {
				// Move to new collection first if the user changed it
				if (selectedCollectionId && selectedCollectionId !== currentCollectionId) {
					await rpc.request.moveContact({ uid: card.uid, targetCollectionId: selectedCollectionId });
				}
				const row = await rpc.request.updateContact({ uid: card.uid, vcf });
				onSave(row?.uid ?? card.uid);
			} else {
				const row = await rpc.request.createContact({ vcf, collectionId: selectedCollectionId });
				onSave(row?.uid ?? "");
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Modal overlay -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	role="dialog"
	aria-modal="true"
>
	<div class="bg-surface-50-950 shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl p-6">
		<h2 class="mb-4 text-lg font-semibold">{card ? "Edit Contact" : "New Contact"}</h2>

		<div class="space-y-4">
			<!-- Name -->
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="text-surface-400 mb-1 block text-xs font-medium">First Name</label>
					<input
						class="input w-full"
						type="text"
						placeholder="First"
						bind:value={firstName}
					/>
				</div>
				<div>
					<label class="text-surface-400 mb-1 block text-xs font-medium">Last Name</label>
					<input
						class="input w-full"
						type="text"
						placeholder="Last"
						bind:value={lastName}
					/>
				</div>
			</div>

			<!-- Org + Title -->
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="text-surface-400 mb-1 block text-xs font-medium">Organization</label>
					<input class="input w-full" type="text" placeholder="Company" bind:value={org} />
				</div>
				<div>
					<label class="text-surface-400 mb-1 block text-xs font-medium">Title</label>
					<input class="input w-full" type="text" placeholder="Job title" bind:value={title} />
				</div>
			</div>

			<!-- Emails -->
			<div>
				<div class="mb-1 flex items-center justify-between">
					<label class="text-surface-400 text-xs font-medium">Email</label>
					<button class="text-primary-500 text-xs hover:underline" onclick={addEmail}>+ Add</button>
				</div>
				{#each emails as email, i}
					<div class="mb-2 flex gap-2">
						<input
							class="input min-w-0 flex-1"
							type="email"
							placeholder="email@example.com"
							bind:value={email.value}
						/>
						<select class="select w-24" bind:value={email.type}>
							{#each EMAIL_TYPES as t}<option value={t}>{t}</option>{/each}
						</select>
						{#if emails.length > 1}
							<button
								class="text-error-500 px-1 text-lg leading-none"
								onclick={() => removeEmail(i)}
								aria-label="Remove email"
							>×</button>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Phones -->
			<div>
				<div class="mb-1 flex items-center justify-between">
					<label class="text-surface-400 text-xs font-medium">Phone</label>
					<button class="text-primary-500 text-xs hover:underline" onclick={addPhone}>+ Add</button>
				</div>
				{#each phones as phone, i}
					<div class="mb-2 flex gap-2">
						<input
							class="input min-w-0 flex-1"
							type="tel"
							placeholder="+1 555 000 0000"
							bind:value={phone.value}
						/>
						<select class="select w-24" bind:value={phone.type}>
							{#each PHONE_TYPES as t}<option value={t}>{t}</option>{/each}
						</select>
						{#if phones.length > 1}
							<button
								class="text-error-500 px-1 text-lg leading-none"
								onclick={() => removePhone(i)}
								aria-label="Remove phone"
							>×</button>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Addresses -->
			<div>
				<div class="mb-1 flex items-center justify-between">
					<label class="text-surface-400 text-xs font-medium">Address</label>
					<button class="text-primary-500 text-xs hover:underline" onclick={addAddress}>+ Add</button>
				</div>
				{#each addresses as adr, i}
					<div class="bg-surface-100-800 mb-2 rounded-lg p-3">
						<div class="mb-2 flex justify-between">
							<select class="select w-24 text-xs" bind:value={adr.type}>
								{#each ADR_TYPES as t}<option value={t}>{t}</option>{/each}
							</select>
							<button
								class="text-error-500 text-sm"
								onclick={() => removeAddress(i)}
								aria-label="Remove address"
							>Remove</button>
						</div>
						<input class="input mb-2 w-full" type="text" placeholder="Street" bind:value={adr.street} />
						<div class="grid grid-cols-2 gap-2">
							<input class="input" type="text" placeholder="City" bind:value={adr.city} />
							<input class="input" type="text" placeholder="Region/State" bind:value={adr.region} />
							<input class="input" type="text" placeholder="Postcode" bind:value={adr.postcode} />
							<input class="input" type="text" placeholder="Country" bind:value={adr.country} />
						</div>
					</div>
				{/each}
			</div>

			<!-- Birthday -->
			<div>
				<label class="text-surface-400 mb-1 block text-xs font-medium">Birthday</label>
				<input class="input" type="date" bind:value={birthday} />
			</div>

			<!-- Notes -->
			<div>
				<label class="text-surface-400 mb-1 block text-xs font-medium">Notes</label>
				<textarea class="textarea w-full" rows="3" placeholder="Notes…" bind:value={note}></textarea>
			</div>

			<!-- Collection selector (create or edit, when multiple collections exist) -->
			{#if collections.length > 1}
				<div>
					<label class="text-surface-400 mb-1 block text-xs font-medium">Collection</label>
					<select class="select w-full" bind:value={selectedCollectionId}>
						{#each collections as col}
							<option value={col.id}>{col.name}</option>
						{/each}
					</select>
				</div>
			{/if}

			{#if error}
				<p class="text-error-500 text-sm">{error}</p>
			{/if}
		</div>

		<!-- Actions -->
		<div class="mt-6 flex gap-3">
			<button class="btn preset-outlined-surface-500 flex-1" onclick={onCancel} disabled={saving}>
				Cancel
			</button>
			<button class="btn preset-filled-primary-500 flex-1" onclick={save} disabled={saving}>
				{saving ? "Saving…" : "Save"}
			</button>
		</div>
	</div>
</div>
