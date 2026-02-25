<script lang="ts">
	import type { Editor } from "@tiptap/core";

	let {
		editor,
		editorUpdated = 0,
	}: {
		editor: Editor | undefined;
		editorUpdated?: number;
	} = $props();

	// Recomputes whenever editorUpdated increments (i.e. on every TipTap transaction)
	const s = $derived(
		editorUpdated >= 0 && editor
			? {
					bold: editor.isActive("bold"),
					italic: editor.isActive("italic"),
					underline: editor.isActive("underline"),
					strike: editor.isActive("strike"),
					h1: editor.isActive("heading", { level: 1 }),
					h2: editor.isActive("heading", { level: 2 }),
					h3: editor.isActive("heading", { level: 3 }),
					bulletList: editor.isActive("bulletList"),
					orderedList: editor.isActive("orderedList"),
					taskList: editor.isActive("taskList"),
					blockquote: editor.isActive("blockquote"),
					code: editor.isActive("code"),
					codeBlock: editor.isActive("codeBlock"),
					canUndo: editor.can().undo(),
					canRedo: editor.can().redo(),
				}
			: null,
	);
</script>

{#if editor && s}
	<div class="flex items-center gap-0.5 px-2 py-1 border-b border-surface-200-800 flex-wrap select-none">
		<!-- Text style -->
		<div class="flex items-center gap-0.5 mr-1">
			<button
				type="button"
				class="px-2 py-0.5 text-xs font-bold rounded hover:bg-surface-100-900 {s.bold ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleBold().run(); }}
				title="Bold (Ctrl+B)"
			>B</button>
			<button
				type="button"
				class="px-2 py-0.5 text-xs italic rounded hover:bg-surface-100-900 {s.italic ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleItalic().run(); }}
				title="Italic (Ctrl+I)"
			>I</button>
			<button
				type="button"
				class="px-2 py-0.5 text-xs underline rounded hover:bg-surface-100-900 {s.underline ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleUnderline().run(); }}
				title="Underline (Ctrl+U)"
			>U</button>
			<button
				type="button"
				class="px-2 py-0.5 text-xs line-through rounded hover:bg-surface-100-900 {s.strike ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleStrike().run(); }}
				title="Strikethrough"
			>S</button>
		</div>

		<div class="w-px h-4 bg-surface-200-800 mx-1"></div>

		<!-- Headings -->
		<div class="flex items-center gap-0.5 mr-1">
			<button
				type="button"
				class="px-1.5 py-0.5 text-xs rounded hover:bg-surface-100-900 {s.h1 ? 'bg-surface-200-800 font-semibold' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleHeading({ level: 1 }).run(); }}
				title="Heading 1"
			>H1</button>
			<button
				type="button"
				class="px-1.5 py-0.5 text-xs rounded hover:bg-surface-100-900 {s.h2 ? 'bg-surface-200-800 font-semibold' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleHeading({ level: 2 }).run(); }}
				title="Heading 2"
			>H2</button>
			<button
				type="button"
				class="px-1.5 py-0.5 text-xs rounded hover:bg-surface-100-900 {s.h3 ? 'bg-surface-200-800 font-semibold' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleHeading({ level: 3 }).run(); }}
				title="Heading 3"
			>H3</button>
		</div>

		<div class="w-px h-4 bg-surface-200-800 mx-1"></div>

		<!-- Lists -->
		<div class="flex items-center gap-0.5 mr-1">
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 {s.bulletList ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleBulletList().run(); }}
				title="Bullet list"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>
					<circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/>
					<circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/>
					<circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/>
				</svg>
			</button>
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 {s.orderedList ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleOrderedList().run(); }}
				title="Numbered list"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/>
					<path d="M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-2-2-1"/>
				</svg>
			</button>
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 {s.taskList ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleTaskList().run(); }}
				title="Task list"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
				</svg>
			</button>
		</div>

		<div class="w-px h-4 bg-surface-200-800 mx-1"></div>

		<!-- Block -->
		<div class="flex items-center gap-0.5 mr-1">
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 {s.blockquote ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleBlockquote().run(); }}
				title="Blockquote"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zm12 0c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>
				</svg>
			</button>
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 {s.code ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleCode().run(); }}
				title="Inline code"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
					<rect x="1" y="4" width="14" height="8" rx="1.5"/>
					<path d="M5 8l-1.5 1 1.5 1M11 8l1.5 1-1.5 1" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 {s.codeBlock ? 'bg-surface-200-800' : ''}"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().toggleCodeBlock().run(); }}
				title="Code block"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
				</svg>
			</button>
		</div>

		<div class="w-px h-4 bg-surface-200-800 mx-1"></div>

		<!-- History -->
		<div class="flex items-center gap-0.5">
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 disabled:opacity-40"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().undo().run(); }}
				disabled={!s.canUndo}
				title="Undo (Ctrl+Z)"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
				</svg>
			</button>
			<button
				type="button"
				class="px-1.5 py-0.5 rounded hover:bg-surface-100-900 disabled:opacity-40"
				onmousedown={(e) => { e.preventDefault(); editor!.chain().focus().redo().run(); }}
				disabled={!s.canRedo}
				title="Redo (Ctrl+Y)"
			>
				<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
				</svg>
			</button>
		</div>
	</div>
{/if}
