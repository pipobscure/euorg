<script lang="ts">
	import { onDestroy } from "svelte";
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
	}: {
		note: NoteRow | null;
		onSave: (uid: string, bodyHtml: string) => void;
		onTitleChange: (uid: string, subject: string) => void;
	} = $props();

	let editorEl = $state<HTMLElement | undefined>();
	let editor = $state<Editor | undefined>();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let titleTimer: ReturnType<typeof setTimeout> | undefined;
	let currentNoteUid = $state<string | null>(null);
	let editorUpdated = $state(0);

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
			content: note?.bodyHtml ?? "",
			onUpdate: ({ editor: ed }) => {
				if (!note) return;
				clearTimeout(saveTimer);
				saveTimer = setTimeout(() => {
					onSave(note.uid, ed.getHTML());
				}, 600);
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
		editor?.destroy();
	});

	function handleTitleInput(e: Event) {
		if (!note) return;
		const val = (e.target as HTMLInputElement).value;
		clearTimeout(titleTimer);
		titleTimer = setTimeout(() => {
			onTitleChange(note!.uid, val);
		}, 600);
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
			<input
				class="w-full bg-transparent text-xl font-semibold outline-none placeholder-surface-400"
				placeholder="Title"
				value={note.subject}
				oninput={handleTitleInput}
			/>
			<div class="text-xs text-surface-500 mt-1">
				{formatDate(note.modifiedAt)}
				{#if note.pendingSync}
					<span class="ml-2 text-warning-500">· unsaved</span>
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

<style>
	:global(.note-editor .ProseMirror) {
		outline: none;
		min-height: 100%;
		font-size: 0.9375rem;
		line-height: 1.7;
	}

	:global(.note-editor .ProseMirror p.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		float: left;
		color: var(--color-surface-400);
		pointer-events: none;
		height: 0;
	}

	/* Headings */
	:global(.note-editor .ProseMirror h1) { font-size: 1.5em; font-weight: 700; margin: 1em 0 0.3em; }
	:global(.note-editor .ProseMirror h2) { font-size: 1.25em; font-weight: 600; margin: 0.9em 0 0.3em; }
	:global(.note-editor .ProseMirror h3) { font-size: 1.1em; font-weight: 600; margin: 0.8em 0 0.25em; }

	/* Paragraph spacing */
	:global(.note-editor .ProseMirror p) { margin: 0.4em 0; }
	:global(.note-editor .ProseMirror p:first-child) { margin-top: 0; }

	/* Lists */
	:global(.note-editor .ProseMirror ul) { list-style: disc; padding-left: 1.5em; margin: 0.4em 0; }
	:global(.note-editor .ProseMirror ol) { list-style: decimal; padding-left: 1.5em; margin: 0.4em 0; }
	:global(.note-editor .ProseMirror li > p) { margin: 0.1em 0; }

	/* Task list */
	:global(.note-editor .ProseMirror ul[data-type="taskList"]) { list-style: none; padding-left: 0.25em; }
	:global(.note-editor .ProseMirror ul[data-type="taskList"] li) { display: flex; align-items: flex-start; gap: 0.5em; }
	:global(.note-editor .ProseMirror ul[data-type="taskList"] li > label) { margin-top: 0.25em; }
	:global(.note-editor .ProseMirror ul[data-type="taskList"] li > div) { flex: 1; }
	:global(.note-editor .ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div) { text-decoration: line-through; opacity: 0.6; }

	/* Blockquote */
	:global(.note-editor .ProseMirror blockquote) {
		border-left: 3px solid var(--color-surface-300-700);
		padding-left: 1em;
		margin: 0.5em 0;
		color: var(--color-surface-600-400);
		font-style: italic;
	}

	/* Code */
	:global(.note-editor .ProseMirror code) {
		background: var(--color-surface-100-900);
		border-radius: 3px;
		padding: 0.1em 0.3em;
		font-family: ui-monospace, monospace;
		font-size: 0.88em;
	}
	:global(.note-editor .ProseMirror pre) {
		background: var(--color-surface-100-900);
		border-radius: 6px;
		padding: 0.75em 1em;
		margin: 0.5em 0;
		overflow-x: auto;
	}
	:global(.note-editor .ProseMirror pre code) {
		background: none;
		padding: 0;
		font-size: 0.875em;
	}

	/* Links */
	:global(.note-editor .ProseMirror a) {
		color: var(--color-primary-500);
		text-decoration: underline;
	}

	/* Horizontal rule */
	:global(.note-editor .ProseMirror hr) {
		border: none;
		border-top: 1px solid var(--color-surface-200-800);
		margin: 1em 0;
	}
</style>
