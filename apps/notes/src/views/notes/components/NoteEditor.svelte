<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import { Editor } from "@tiptap/core";
	import StarterKit from "@tiptap/starter-kit";
	import Underline from "@tiptap/extension-underline";
	import Link from "@tiptap/extension-link";
	import TaskList from "@tiptap/extension-task-list";
	import TaskItem from "@tiptap/extension-task-item";
	import Placeholder from "@tiptap/extension-placeholder";
	import Typography from "@tiptap/extension-typography";
	import Toolbar from "./Toolbar.svelte";
	import type { NoteRow } from "../lib/types.ts";

	let {
		note,
		onSave,
		onTitleChange,
		onDelete,
		onTagsChange,
	}: {
		note: NoteRow | null;
		onSave: (uid: string, bodyHtml: string) => void;
		onTitleChange: (uid: string, subject: string) => void;
		onDelete: (uid: string) => void;
		onTagsChange: (uid: string, tags: string[]) => void;
	} = $props();

	let editorEl = $state<HTMLElement | undefined>();
	let editor = $state<Editor | undefined>();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let titleTimer: ReturnType<typeof setTimeout> | undefined;
	let deleteTimer: ReturnType<typeof setTimeout> | undefined;
	let currentNoteUid = $state<string | null>(null);
	let editorUpdated = $state(0);
	let confirmingDelete = $state(false);

	// Tag editing
	let addingTag = $state(false);
	let newTagValue = $state("");
	let tagInputEl = $state<HTMLInputElement | undefined>();

	function removeTag(tag: string) {
		if (!note) return;
		onTagsChange(note.uid, note.tags.filter((t) => t !== tag));
	}

	function commitTag() {
		if (!note) return;
		const trimmed = newTagValue.trim().toLowerCase().replace(/\s+/g, "-");
		if (trimmed && !note.tags.includes(trimmed)) {
			onTagsChange(note.uid, [...note.tags, trimmed]);
		}
		newTagValue = "";
		addingTag = false;
	}

	function handleTagKeydown(e: KeyboardEvent) {
		if (e.key === "Enter" || e.key === ",") {
			e.preventDefault();
			commitTag();
		} else if (e.key === "Escape") {
			newTagValue = "";
			addingTag = false;
		}
	}

	$effect(() => {
		if (addingTag) {
			// Focus the input on next tick
			setTimeout(() => tagInputEl?.focus(), 0);
		}
	});

	$effect(() => {
		if (!editorEl) return;

		editor = new Editor({
			element: editorEl,
			extensions: [
				StarterKit,
				Underline,
				Link.configure({ openOnClick: false }),
				TaskList,
				TaskItem.configure({ nested: true }),
				Typography,
				Placeholder.configure({ placeholder: "Start writing…" }),
			],
			content: untrack(() => note?.bodyHtml ?? ""),
			onUpdate: ({ editor: ed }) => {
				if (!note) return;
				clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					onSave(note.uid, ed.getHTML());
				}, 2000);
			},
			onTransaction: () => {
				editorUpdated++;
			},
		});

		// Keep editor reactive to note selection changes
		const unsub = $effect.root(() => {
			$effect(() => {
				if (editor && note && note.uid !== currentNoteUid) {
					currentNoteUid = note.uid;
					clearTimeout(saveTimer);
					clearTimeout(deleteTimer);
					confirmingDelete = false;
					editor.commands.setContent(note.bodyHtml || "");
				}
			});
		});

		return () => {
			clearTimeout(saveTimer);
			clearTimeout(titleTimer);
			editor?.destroy();
			editor = undefined;
			unsub();
		};
	});

	onDestroy(() => {
		clearTimeout(saveTimer);
		clearTimeout(titleTimer);
		clearTimeout(deleteTimer);
		editor?.destroy();
	});

	function handleDeleteClick() {
		if (!note) return;
		if (confirmingDelete) {
			clearTimeout(deleteTimer);
			confirmingDelete = false;
			onDelete(note.uid);
		} else {
			confirmingDelete = true;
			deleteTimer = setTimeout(() => { confirmingDelete = false; }, 3000);
		}
	}

	function handleTitleInput(e: Event) {
		if (!note) return;
		const val = (e.target as HTMLInputElement).value;
		clearTimeout(titleTimer);
		titleTimer = setTimeout(() => {
			onTitleChange(note!.uid, val);
		}, 2000);
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString([], {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}
</script>

{#if !note}
	<div class="flex items-center justify-center h-full text-surface-400 text-sm select-none">
		Select a note or create a new one
	</div>
{:else}
	<div class="flex flex-col h-full">
		<!-- Title row -->
		<div class="px-6 pt-5 pb-2 border-b border-surface-200-800">
			<div class="flex items-start gap-2">
				<input
					class="flex-1 bg-transparent text-xl font-semibold outline-none placeholder-surface-400"
					placeholder="Title"
					value={note.subject}
					oninput={handleTitleInput}
				/>
				<button
					type="button"
					class="mt-1 p-1 rounded shrink-0 transition-colors {confirmingDelete ? 'text-error-500 bg-error-500/10 hover:bg-error-500/20' : 'text-surface-400 hover:text-error-500 hover:bg-error-500/10'}"
					onclick={handleDeleteClick}
					title={confirmingDelete ? 'Click again to confirm delete' : 'Delete note'}
				>
					{#if confirmingDelete}
						<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="20 6 9 17 4 12"/>
						</svg>
					{:else}
						<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
						</svg>
					{/if}
				</button>
			</div>
			<div class="text-xs text-surface-500 mt-1">
				{formatDate(note.modifiedAt)}
				{#if note.pendingSync}
					<span class="ml-2 text-warning-500">· unsaved</span>
				{/if}
				{#if confirmingDelete}
					<span class="ml-2 text-error-500">· click trash again to confirm</span>
				{/if}
			</div>
			<!-- Tags -->
			<div class="flex flex-wrap items-center gap-1 mt-2">
				{#each note.tags as tag}
					<span class="inline-flex items-center gap-0.5 px-2 py-0.5 text-xs rounded-full bg-surface-200-800 text-surface-700-300">
						{tag}
						<button
							type="button"
							class="ml-0.5 opacity-60 hover:opacity-100 leading-none"
							onclick={() => removeTag(tag)}
							title="Remove tag"
						>×</button>
					</span>
				{/each}
				{#if addingTag}
					<input
						bind:this={tagInputEl}
						bind:value={newTagValue}
						type="text"
						class="px-2 py-0.5 text-xs rounded-full border border-primary-400 bg-transparent outline-none w-24"
						placeholder="tag name"
						onkeydown={handleTagKeydown}
						onblur={commitTag}
					/>
				{:else}
					<button
						type="button"
						class="px-2 py-0.5 text-xs rounded-full border border-dashed border-surface-300-700 text-surface-400 hover:border-primary-400 hover:text-primary-500 transition-colors"
						onclick={() => addingTag = true}
					>+ tag</button>
				{/if}
			</div>
		</div>

		<!-- Toolbar -->
		<Toolbar {editor} {editorUpdated} />

		<!-- Editor area -->
		<div class="flex-1 overflow-y-auto">
			<div
				bind:this={editorEl}
				class="note-editor h-full px-6 py-4 outline-none"
			></div>
		</div>
	</div>
{/if}
