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
	import type { NoteRow, AttachmentRow } from "../lib/types.ts";

	let {
		note,
		onSave,
		onTitleChange,
		onDelete,
		onTagsChange,
		onAddAttachment,
		onRemoveAttachment,
		onOpenAttachment,
		onGetAttachmentData,
		onOpenUrl,
		onSaveAttachment,
	}: {
		note: NoteRow | null;
		onSave: (uid: string, bodyHtml: string) => void;
		onTitleChange: (uid: string, subject: string) => void;
		onDelete: (uid: string) => void;
		onTagsChange: (uid: string, tags: string[]) => void;
		onAddAttachment: (uid: string, filename: string, mimeType: string, data: string) => void;
		onRemoveAttachment: (uid: string, attachmentId: string) => void;
		onOpenAttachment: (attachmentId: string) => void;
		onGetAttachmentData: (attachmentId: string) => Promise<{ data: string; mimeType: string; filename: string } | null>;
		onOpenUrl: (url: string) => void;
		onSaveAttachment: (attachmentId: string) => Promise<string | null>;
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

	// Attachment state
	let isDraggingOver = $state(false);
	let fileInputEl = $state<HTMLInputElement | undefined>();
	let contextMenu = $state<{ att: AttachmentRow; x: number; y: number } | null>(null);

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
				Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
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

	// ── Attachments ────────────────────────────────────────────────────────────

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function fileIconForMime(mimeType: string): string {
		if (/^image\//.test(mimeType)) return "🖼";
		if (/^video\//.test(mimeType)) return "🎬";
		if (/^audio\//.test(mimeType)) return "🎵";
		if (/pdf/.test(mimeType)) return "📄";
		if (/zip|archive|tar|gz|7z|rar/.test(mimeType)) return "🗜";
		if (/text\//.test(mimeType)) return "📝";
		if (/spreadsheet|excel|csv/.test(mimeType)) return "📊";
		if (/presentation|powerpoint/.test(mimeType)) return "📊";
		return "📎";
	}

	const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB

	async function processFiles(files: FileList | File[]) {
		if (!note) return;
		for (const file of Array.from(files)) {
			if (file.size > MAX_ATTACHMENT_SIZE) {
				alert(`"${file.name}" is too large (${formatSize(file.size)}). Maximum attachment size is 10 MB.`);
				continue;
			}
			const data = await fileToBase64(file);
			onAddAttachment(note.uid, file.name, file.type || "application/octet-stream", data);
		}
	}

	function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				// result is "data:mime;base64,..." — strip the prefix
				const result = reader.result as string;
				resolve(result.split(",")[1]);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	function handleDragOver(e: DragEvent) {
		if (!note) return;
		if (e.dataTransfer?.types.includes("Files")) {
			e.preventDefault();
			isDraggingOver = true;
		}
	}

	function handleDragLeave(e: DragEvent) {
		// Only clear if leaving the whole editor area
		const related = e.relatedTarget as Node | null;
		if (!editorWrapper?.contains(related)) {
			isDraggingOver = false;
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDraggingOver = false;
		if (!note || !e.dataTransfer?.files.length) return;
		processFiles(e.dataTransfer.files);
	}

	function handleFileInput(e: Event) {
		const files = (e.target as HTMLInputElement).files;
		if (files) processFiles(files);
		// Reset so the same file can be re-selected
		(e.target as HTMLInputElement).value = "";
	}

	function handleEditorLinkClick(e: MouseEvent) {
		const anchor = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
		if (!anchor) return;
		e.preventDefault();
		const href = anchor.getAttribute('href') || anchor.href;
		if (!href) return;
		// Only open URLs with a recognised scheme (the OS decides if a handler exists)
		try {
			const { protocol } = new URL(href);
			if (protocol) onOpenUrl(href);
		} catch { /* not a valid URL, ignore */ }
	}

	function showContextMenu(e: MouseEvent, att: AttachmentRow) {
		e.preventDefault();
		contextMenu = { att, x: e.clientX, y: e.clientY };
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	async function saveAttachmentCopy(att: AttachmentRow) {
		closeContextMenu();
		const dest = await onSaveAttachment(att.id);
		if (dest) {
			alert(`Saved to: ${dest}`);
		}
	}

	let editorWrapper = $state<HTMLElement | undefined>();
</script>

<!-- Close context menu on click outside -->
<svelte:window onclick={(e) => {
	if (contextMenu && !(e.target as Element).closest('.attachment-context-menu')) {
		closeContextMenu();
	}
}} />

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
		<Toolbar {editor} {editorUpdated}>
			{#snippet extra()}
				<!-- Attach file button -->
				<button
					type="button"
					class="btn-icon btn-icon-sm hover:preset-tonal rounded"
					title="Attach file"
					onclick={() => fileInputEl?.click()}
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
					</svg>
				</button>
				<input
					bind:this={fileInputEl}
					type="file"
					multiple
					class="hidden"
					onchange={handleFileInput}
				/>
			{/snippet}
		</Toolbar>

		<!-- Editor area with drag-and-drop -->
		<div
			bind:this={editorWrapper}
			class="flex-1 overflow-y-auto relative"
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
			onclick={handleEditorLinkClick}
		>
			<div
				bind:this={editorEl}
				class="note-editor h-full px-6 py-4 outline-none"
			></div>

			<!-- Drop overlay -->
			{#if isDraggingOver}
				<div class="absolute inset-0 z-10 flex items-center justify-center bg-surface-50-950/80 border-2 border-dashed border-primary-500 rounded pointer-events-none">
					<div class="text-center">
						<svg class="w-10 h-10 mx-auto mb-2 text-primary-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
							<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
						</svg>
						<p class="text-sm font-medium text-primary-500">Drop to attach</p>
					</div>
				</div>
			{/if}
		</div>

		<!-- Attachment strip (shown when note has attachments) -->
		{#if note.attachments && note.attachments.length > 0}
			<div class="border-t border-surface-200-800 px-4 py-2 flex flex-wrap gap-2">
				{#each note.attachments as att (att.id)}
					<div
						class="group relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-100-900 hover:bg-surface-200-800 cursor-pointer transition-colors text-sm"
						onclick={() => onOpenAttachment(att.id)}
						oncontextmenu={(e) => showContextMenu(e, att)}
						title={att.filename}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && onOpenAttachment(att.id)}
					>
						<span class="text-base leading-none select-none">{fileIconForMime(att.mimeType)}</span>
						<div class="min-w-0">
							<div class="truncate max-w-32 text-xs font-medium">{att.filename}</div>
							<div class="text-xs text-surface-500">{formatSize(att.size)}</div>
						</div>
						<!-- Remove button (shown on hover) -->
						<button
							type="button"
							class="ml-1 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity text-surface-500 hover:text-error-500"
							title="Remove attachment"
							onclick={(e) => { e.stopPropagation(); note && onRemoveAttachment(note.uid, att.id); }}
						>
							<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<path d="M18 6 6 18M6 6l12 12"/>
							</svg>
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Context menu -->
	{#if contextMenu}
		<div
			class="attachment-context-menu fixed z-50 bg-surface-50-950 border border-surface-200-800 rounded-lg shadow-lg py-1 min-w-32 text-sm"
			style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
		>
			<button
				type="button"
				class="w-full text-left px-3 py-1.5 hover:bg-surface-100-900 transition-colors"
				onclick={() => { onOpenAttachment(contextMenu!.att.id); closeContextMenu(); }}
			>Open</button>
			<button
				type="button"
				class="w-full text-left px-3 py-1.5 hover:bg-surface-100-900 transition-colors"
				onclick={() => saveAttachmentCopy(contextMenu!.att)}
			>Save a copy…</button>
			<div class="border-t border-surface-200-800 my-1"></div>
			<button
				type="button"
				class="w-full text-left px-3 py-1.5 hover:bg-surface-100-900 text-error-500 transition-colors"
				onclick={() => { note && onRemoveAttachment(note.uid, contextMenu!.att.id); closeContextMenu(); }}
			>Remove</button>
		</div>
	{/if}
{/if}
