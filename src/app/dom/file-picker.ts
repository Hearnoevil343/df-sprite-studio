// A native `<input type="file">`'s own "Choose File" label can't be styled,
// and its "No file chosen" text gets clipped to a character or two in a
// narrow dock column (looks like a rendering bug, not hidden-on-purpose).
// This hides the native input and drives it from a normal button instead,
// showing the picked file's name (or nothing) in our own span.
export type FilePicker = { wrap: HTMLElement; input: HTMLInputElement };

export function createFilePicker(opts: {
  accept?: string;
  title?: string;
  buttonLabel?: string;
  className?: string;
}): FilePicker {
  const input = document.createElement('input');
  input.type = 'file';
  if (opts.accept) input.accept = opts.accept;
  input.style.display = 'none';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = opts.buttonLabel ?? 'Choose file';
  if (opts.title) button.title = opts.title;

  const name = document.createElement('span');
  name.className = 'file-picker-name';

  button.addEventListener('click', ev => {
    ev.stopPropagation();
    input.click();
  });
  input.addEventListener('click', ev => ev.stopPropagation());
  input.addEventListener('change', () => {
    name.textContent = input.files?.[0]?.name ?? '';
  });

  const wrap = document.createElement('span');
  wrap.className = ['file-picker', opts.className].filter(Boolean).join(' ');
  wrap.append(button, name, input);

  return { wrap, input };
}
