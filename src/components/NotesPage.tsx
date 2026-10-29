import NotesPageShell from "./notes/NotesPageShell";
import { useNotesPageModel } from "./notes/useNotesPageModel";
import type { NotesPageProps } from "./notes/notesPageCtx";

/** Assemble the notes hooks and pass their state to the presentation shell. */
export default function NotesPage(props: NotesPageProps) {
    const model = useNotesPageModel(props);
    return <NotesPageShell {...model} />;
}
