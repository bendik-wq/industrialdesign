// One plain-English industry → each country's official activity codes.
//   fr: NAF rév. 2 (INSEE)   no: SN2025 (SSB / Brønnøysund)   uk: SIC 2007 (Companies House)
//   places: Google Places search phrase for countries without a registry connector
export const INDUSTRIES = [
  { id: "hvac", label: "HVAC / heating & cooling", fr: ["43.22B"], no: ["43.222", "43.223"], uk: ["43220"], places: "HVAC contractor" },
  { id: "plumbing", label: "Plumbing", fr: ["43.22A"], no: ["43.221"], uk: ["43220"], places: "plumber" },
  { id: "electrical", label: "Electrical contractors", fr: ["43.21A"], no: ["43.210"], uk: ["43210"], places: "electrical contractor" },
  { id: "roofing", label: "Roofing", fr: ["43.91A", "43.91B"], no: ["43.410"], uk: ["43910"], places: "roofing contractor" },
  { id: "landscaping", label: "Landscaping & grounds", fr: ["81.30Z"], no: ["81.300"], uk: ["81300"], places: "landscaping company" },
  { id: "cleaning", label: "Commercial cleaning", fr: ["81.21Z", "81.22Z"], no: ["81.210", "81.220"], uk: ["81210", "81221", "81222", "81229"], places: "commercial cleaning company" },
  { id: "pest", label: "Pest control", fr: ["81.29A"], no: [], uk: ["81291"], places: "pest control" },
  { id: "dental", label: "Dental practices", fr: ["86.23Z"], no: ["86.230"], uk: ["86230"], places: "dental practice" },
  { id: "gp", label: "GP / medical practices", fr: ["86.21Z"], no: ["86.210"], uk: ["86210"], places: "medical clinic" },
  { id: "physio", label: "Physiotherapy & allied health", fr: ["86.90E"], no: ["86.950"], uk: ["86900"], places: "physiotherapy clinic" },
  { id: "vet", label: "Veterinary clinics", fr: ["75.00Z"], no: ["75.000"], uk: ["75000"], places: "veterinary clinic" },
  { id: "accounting", label: "Accounting & bookkeeping", fr: ["69.20Z"], no: ["69.201", "69.202", "69.203"], uk: ["69201", "69202", "69203"], places: "accounting firm" },
  { id: "insurance", label: "Insurance brokers", fr: ["66.22Z"], no: [], uk: ["66220"], places: "insurance broker" },
  { id: "it", label: "IT services / MSPs", fr: ["62.02A", "62.03Z"], no: ["62.200", "62.900"], uk: ["62020", "62030", "62090"], places: "IT services company" },
  { id: "auto", label: "Auto repair", fr: ["45.20A", "45.20B"], no: ["95.310"], uk: ["45200"], places: "auto repair shop" },
  { id: "trucking", label: "Freight trucking", fr: ["49.41A", "49.41B"], no: ["49.410"], uk: ["49410"], places: "trucking company" },
  { id: "waste", label: "Waste collection", fr: ["38.11Z"], no: ["38.110"], uk: ["38110"], places: "waste management company" },
  { id: "security", label: "Security & guarding", fr: ["80.10Z"], no: ["80.010", "80.090"], uk: ["80100"], places: "security guard company" },
  { id: "engineering", label: "Engineering consultancies", fr: ["71.12B"], no: ["71.121", "71.129"], uk: ["71121", "71122", "71129"], places: "engineering consulting firm" },
  { id: "funeral", label: "Funeral homes", fr: ["96.03Z"], no: ["96.300"], uk: ["96030"], places: "funeral home" },
  { id: "childcare", label: "Childcare / nurseries", fr: ["88.91A"], no: ["88.910"], uk: ["88910"], places: "daycare center" },
];
export const industryById = (id) => INDUSTRIES.find((i) => i.id === id);
