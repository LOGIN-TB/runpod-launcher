/**
 * Keeping the chosen build of a GGUF repository.
 *
 * A repository carries every quantisation side by side, and which one is loaded
 * decides both the size on the card and the quality of the answers. So the
 * choice has to survive being saved and reopened — and that is exactly what it
 * did not do: the editor started with nothing selected, adopted the default, and
 * showed the first entry in the list instead of the Q4 that had been chosen.
 * Saving then changed the model without a word.
 */

/** What the repository offers, as far as this decision cares. */
export interface OfferedVariant {
  variant: string
}

/**
 * The build to select.
 *
 * The saved one while the repository still offers it, otherwise `fallback` —
 * which is the service's own default, so there is one rule for that and it
 * lives where the repository is actually inspected.
 *
 * The fallback case matters as much as the main one. A value the dropdown has no
 * option for does not render blank: the browser shows the first option while the
 * state holds something else, which is the same silent substitution wearing a
 * different hat.
 */
export function chooseVariant(
  saved: string | null,
  offered: readonly OfferedVariant[] | undefined,
  fallback: string | null,
): string | null {
  // Not a GGUF repository, so there is nothing to choose between; whatever was
  // saved is passed through rather than discarded.
  if (offered === undefined) return saved

  if (saved !== null && offered.some((option) => option.variant === saved)) return saved
  return fallback
}
