// All records here are invented examples. Never place customer or private catalog data here.
export const catalog = [
  {
    id: "demo-expo-001",
    name: "Example Industry Expo",
    city: "Sample City",
    country: "Exampleland",
    startsOn: "2027-05-12",
    endsOn: "2027-05-14",
    website: "https://example.invalid/exhibitions/industry-expo"
  },
  {
    id: "demo-expo-002",
    name: "Synthetic Manufacturing Forum",
    city: "Testburg",
    country: "Exampleland",
    startsOn: "2027-09-20",
    endsOn: "2027-09-21",
    website: "https://example.invalid/exhibitions/manufacturing-forum"
  }
];

// Profile assignments are invented test data. They are not production authorization rules.
export const companies = [
  {
    id: "demo-company-001",
    name: "Example Components Ltd.",
    country: "Exampleland",
    exhibitionIds: ["demo-expo-001"]
  },
  {
    id: "demo-company-002",
    name: "Synthetic Manufacturing Group",
    country: "Exampleland",
    exhibitionIds: ["demo-expo-002"]
  }
];

export const syntheticProfileCompanies = {
  "demo-profile-a": ["demo-company-001"],
  "demo-profile-b": ["demo-company-002"]
};

// Private qualification overlays are deliberately synthetic and never selected from request data.
export const syntheticProfileCompanyOverlays = {
  "demo-profile-a": { "demo-company-001": { qualification: "target", reason: "synthetic-profile-a-rule" } },
  "demo-profile-b": { "demo-company-002": { qualification: "review", reason: "synthetic-profile-b-rule" } }
};

// Synthetic empty preleads used to exercise S-03 timelines. No note or disposition text is seeded.
export const syntheticPreleads = [
  { id: "demo-prelead-001", profileId: "demo-profile-a", companyId: "demo-company-001", exhibitionId: "demo-expo-001", stage: "draft" },
  { id: "demo-prelead-002", profileId: "demo-profile-b", companyId: "demo-company-002", exhibitionId: "demo-expo-002", stage: "draft" }
];
