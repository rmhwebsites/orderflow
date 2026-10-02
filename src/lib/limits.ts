// Input limits shared by the server validation and the client forms, so a
// form can never accept what the API will refuse.

// A note's maximum length after trimming, in UTF-16 code units: the same
// unit a textarea's maxLength counts.
export const NOTE_MAX = 4000;
