// One plain-English industry → each country's official activity codes.
//   uk: SIC 2007 (Companies House)
//   places: Google Places search phrase for countries without a registry connector
export const INDUSTRIES = [
  { id: "hvac", label: "HVAC / heating & cooling", uk: ["43220"], places: "HVAC contractor" },
  { id: "plumbing", label: "Plumbing", uk: ["43220"], places: "plumber" },
  { id: "electrical", label: "Electrical contractors", uk: ["43210"], places: "electrical contractor" },
  { id: "roofing", label: "Roofing", uk: ["43910"], places: "roofing contractor" },
  { id: "landscaping", label: "Landscaping & grounds", uk: ["81300"], places: "landscaping company" },
  { id: "cleaning", label: "Commercial cleaning", uk: ["81210", "81221", "81222", "81229"], places: "commercial cleaning company" },
  { id: "pest", label: "Pest control", uk: ["81291"], places: "pest control" },
  { id: "dental", label: "Dental practices", uk: ["86230"], places: "dental practice" },
  { id: "gp", label: "GP / medical practices", uk: ["86210"], places: "medical clinic" },
  { id: "physio", label: "Physiotherapy & allied health", uk: ["86900"], places: "physiotherapy clinic" },
  { id: "vet", label: "Veterinary clinics", uk: ["75000"], places: "veterinary clinic" },
  { id: "accounting", label: "Accounting & bookkeeping", uk: ["69201", "69202", "69203"], places: "accounting firm" },
  { id: "insurance", label: "Insurance brokers", uk: ["66220"], places: "insurance broker" },
  { id: "it", label: "IT services / MSPs", uk: ["62020", "62030", "62090"], places: "IT services company" },
  { id: "auto", label: "Auto repair", uk: ["45200"], places: "auto repair shop" },
  { id: "trucking", label: "Freight trucking", uk: ["49410"], places: "trucking company" },
  { id: "waste", label: "Waste collection", uk: ["38110"], places: "waste management company" },
  { id: "security", label: "Security & guarding", uk: ["80100"], places: "security guard company" },
  { id: "engineering", label: "Engineering consultancies", uk: ["71121", "71122", "71129"], places: "engineering consulting firm" },
  { id: "funeral", label: "Funeral homes", uk: ["96030"], places: "funeral home" },
  { id: "childcare", label: "Childcare / nurseries", uk: ["88910"], places: "daycare center" },
];
export const industryById = (id) => INDUSTRIES.find((i) => i.id === id);
