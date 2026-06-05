/**
 * Canonical user-facing wording. One source of truth so the same concept isn't called
 * five different things across screens. Engine/implementation names stay out of primary UI.
 */
export const LEXICON = {
  // The two AI actions in the editor — described by what they do, not the engine.
  analyzePlan: 'Analyze plan',                 // re-reads the plan image (CV pipeline)
  analyzePlanBusy: 'Analyzing plan…',
  analyzePlanHelp: 'Re-reads the plan image to detect spaces, doors, scale and devices.',
  suggestDevices: 'Suggest devices',           // re-runs rules on the reviewed spaces
  suggestDevicesBusy: 'Suggesting devices…',
  suggestDevicesHelp: 'Re-applies the engineering rules to your reviewed spaces. Does not re-read the image.',
  // Entities — always "spaces", never "rooms" in UI.
  spaces: 'Spaces',
  devices: 'Devices',
} as const;
