// P1: PH address reference seed — CURATED SUBSET (Metro Manila + demo provinces/cities).
// Full PSGC dataset (~42k barangays) is PENDING — this ships REAL names for the hierarchy
// so the cascading checkout works today. Codes are stable PSGC-style strings.
// Idempotent: upserts by code; a city's barangays are replaced on re-run.

//   npx tsx prisma/seed-ph-addresses.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type City = { code: string; name: string; type: "city" | "municipality"; barangays: string[] };
type Province = { code: string; name: string; cities: City[] };
type Region = { code: string; name: string; sortOrder: number; provinces: Province[] };

const DATA: Region[] = [
  {
    code: "reg-ncr",
    name: "Metro Manila (NCR)",
    sortOrder: 1,
    provinces: [
      {
        code: "prov-ncr",
        name: "Metro Manila",
        cities: [
          {
            code: "city-manila",
            name: "City of Manila",
            type: "city",
            barangays: [
              "Binondo",
              "Ermita",
              "Intramuros",
              "Malate",
              "Paco",
              "Pandacan",
              "Port Area",
              "Quiapo",
              "Sampaloc",
              "San Andres",
              "San Miguel",
              "San Nicolas",
              "Santa Ana",
              "Santa Cruz",
              "Santa Mesa",
              "Tondo",
            ],
          },
          {
            code: "city-quezon-city",
            name: "Quezon City",
            type: "city",
            barangays: [
              "Aurora",
              "Batasan Hills",
              "Commonwealth",
              "Cubao",
              "Diliman",
              "Fairview",
              "Holy Spirit",
              "Laging Handa",
              "Loyola Heights",
              "New Era",
              "Novaliches Proper",
              "Pasong Tamo",
              "Payatas",
              "Project 6",
              "San Agustin",
              "Sauyo",
              "Sikatuna Village",
              "Tandang Sora",
              "Teachers Village",
              "U.P. Campus",
              "U.P. Village",
              "Old Balara",
            ],
          },
          {
            code: "city-caloocan",
            name: "Caloocan",
            type: "city",
            barangays: [
              "Bagong Barrio",
              "Camarin",
              "Deparo",
              "Kaunlaran",
              "Maypajo",
              "Paltok",
              "Sangandaan",
              "Tala",
              "Amparo",
              "Bagumbong",
            ],
          },
          {
            code: "city-las-pinas",
            name: "Las Piñas",
            type: "city",
            barangays: [
              "Almanza Uno",
              "Almanza Dos",
              "Daniel Fajardo",
              "Elias Aldana",
              "Ilaya",
              "Manuyo Uno",
              "Manuyo Dos",
              "Pamplona Uno",
              "Pamplona Dos",
              "Pilar Village",
              "Pulang Lupa Uno",
              "Talon Uno",
            ],
          },
          {
            code: "city-makati",
            name: "Makati",
            type: "city",
            barangays: [
              "Bangkal",
              "Bel-Air",
              "Cembo",
              "Comembo",
              "Dasmarinas",
              "Forbes Park",
              "Guadalupe Nuevo",
              "Guadalupe Viejo",
              "La Paz",
              "Olympia",
              "Palanan",
              "Pembo",
              "Pio del Pilar",
              "Pitogo",
              "Poblacion",
              "San Antonio",
              "San Isidro",
              "San Lorenzo",
              "San Miguel",
              "Santa Cruz",
              "Singkamas",
              "Urdaneta",
              "Valenzuela",
              "West Rembo",
            ],
          },
          {
            code: "city-malabon",
            name: "Malabon",
            type: "city",
            barangays: [
              "Acacia",
              "Baritan",
              "Bayan-bayanan",
              "Catmon",
              "Concepcion",
              "Dampalit",
              "Flores",
              "Longos",
              "Maysilo",
              "Muzon",
              "Niugan",
              "Panghulo",
              "Potrero",
              "Tinajeros",
              "Tugatog",
            ],
          },
          {
            code: "city-mandaluyong",
            name: "Mandaluyong",
            type: "city",
            barangays: [
              "Addition Hills",
              "Bagong Silang",
              "Barangka Drive",
              "Burol",
              "Buayang Bato",
              "Daang Bakal",
              "Hagdang Bato Libis",
              "Harapin Ang Bukas",
              "Highway Hills",
              "Hulo",
              "Mabini",
              "Malamig",
              "Mauway",
              "Poblacion",
              "San Agustin",
              "San Jose",
              "San Miguel",
              "Vergara",
              "Pleasant Hills",
            ],
          },
          {
            code: "city-marikina",
            name: "Marikina",
            type: "city",
            barangays: [
              "Barangka",
              "Calumpang",
              "Concepcion Dos",
              "Concepcion Uno",
              "Fortune",
              "Industrial Valley",
              "Jesus Dela Pena",
              "Malanday",
              "Marikina Heights",
              "Nangka",
              "Parang",
              "San Roque",
              "Santo Nino",
              "Santa Elena",
              "Tanong",
            ],
          },
          {
            code: "city-muntinlupa",
            name: "Muntinlupa",
            type: "city",
            barangays: [
              "Alabang",
              "Ayala Alabang",
              "Bayanan",
              "Buli",
              "Cupang",
              "Poblacion",
              "Putatan",
              "Sucat",
              "Tunasan",
            ],
          },
          {
            code: "city-navotas",
            name: "Navotas",
            type: "city",
            barangays: [
              "Bagumbayan North",
              "Bagumbayan South",
              "Bangkulasi",
              "Daang Hari",
              "Navotas East",
              "Navotas West",
              "San Jose",
              "San Rafael Village",
              "San Roque",
              "Sipac-Almacen",
              "Tangos North",
              "Tondo North",
              "Tondo South",
            ],
          },
          {
            code: "city-paranaque",
            name: "Parañaque",
            type: "city",
            barangays: [
              "Baclaran",
              "B.F. Homes",
              "Don Bosco",
              "Don Galo",
              "La Huerta",
              "Marcelo Green",
              "Merville",
              "San Dionisio",
              "San Isidro",
              "San Martin de Porres",
              "San Miguel",
              "San Nicolas",
              "San Valentin",
              "Santo Nino",
              "Tambo",
              "Vitalez",
            ],
          },
          {
            code: "city-pasay",
            name: "Pasay",
            type: "city",
            barangays: [
              "Malibay",
              "Maricaban",
              "San Isidro",
              "San Jose",
              "San Rafael",
              "Santa Clara",
              "Trinidad",
            ],
          },
          {
            code: "city-pasig",
            name: "Pasig",
            type: "city",
            barangays: [
              "Bagong Ilog",
              "Bagong Katipunan",
              "Bambang",
              "Buting",
              "Caniogan",
              "Dela Paz",
              "Kalawaan",
              "Kapasigan",
              "Kapitolyo",
              "Malinao",
              "Manggahan",
              "Maybunga",
              "Oranbo",
              "Palatiw",
              "Pinagbuhatan",
              "Pineda",
              "Rosario",
              "San Joaquin",
              "San Jose",
              "San Martin de Porres",
              "Santa Lucia",
              "Santo Tomas",
              "Santolan",
              "Sumilang",
              "Ugong",
            ],
          },
          {
            code: "city-pateros",
            name: "Pateros",
            type: "municipality",
            barangays: ["Magtanggol", "Poblacion", "San Pedro", "San Roque", "Santa Ana", "Tabacalera"],
          },
          {
            code: "city-san-juan",
            name: "San Juan",
            type: "city",
            barangays: [
              "Addition Hills",
              "Balong-Bato",
              "Barangka Ilaya",
              "Batis",
              "Corazon de Jesus",
              "Greenhills",
              "Isabel",
              "Little Baguio",
              "Malamig",
              "Maytunas",
              "Onse",
              "Pasadena",
              "Progreso",
              "Rivera",
              "Salapan",
              "San Perfecto",
              "Santa Lucia",
              "Southeast",
              "Tibagan",
              "West Crame",
            ],
          },
          {
            code: "city-taguig",
            name: "Taguig",
            type: "city",
            barangays: [
              "Bagong Tanyag",
              "Bagumbayan",
              "Bambang",
              "Bicutan",
              "Calzada",
              "Central Bicutan",
              "Hagonoy",
              "IBP",
              "Katuparan",
              "Ligid Tipas",
              "Maharlika Village",
              "Napindan",
              "New Lower Bicutan",
              "Pinagsama",
              "San Miguel",
              "Signal Village",
              "Sta. Ana",
              "Tuktukan",
              "Ususan",
              "Wawa",
            ],
          },
          {
            code: "city-valenzuela",
            name: "Valenzuela",
            type: "city",
            barangays: [
              "Arkong Bato",
              "Balangkas",
              "Biga",
              "Canumay East",
              "Dalandanan",
              "Isla",
              "Karuhatan",
              "Lawang Bato",
              "Lingunan",
              "Mabolo",
              "Malinta",
              "Marulas",
              "Maysan",
              "Palasan",
              "Paso de Blas",
              "Poblacion",
              "Pulo",
              "Punturin",
              "Rincon",
              "Tagalag",
              "Viente Reales",
            ],
          },
        ],
      },
    ],
  },
  {
    code: "reg-car",
    name: "Cordillera Administrative Region",
    sortOrder: 2,
    provinces: [
      {
        code: "prov-benguet",
        name: "Benguet",
        cities: [
          {
            code: "city-baguio",
            name: "Baguio",
            type: "city",
            barangays: [
              "Aurora Hill",
              "Bakakeng",
              "Cabinet Hill",
              "Dontogan",
              "Greenwater Village",
              "Loakan",
              "Magsaysay",
              "Pinsao",
              "San Luis Village",
              "Scout Barrio",
            ],
          },
        ],
      },
    ],
  },
  {
    code: "reg-i",
    name: "Ilocos Region",
    sortOrder: 3,
    provinces: [
      {
        code: "prov-pangasinan",
        name: "Pangasinan",
        cities: [
          {
            code: "city-dagupan",
            name: "Dagupan",
            type: "city",
            barangays: ["Bonuan Binloc", "Bonuan Boquig", "Bonuan Gueset", "Lasip Chico", "Malued", "Poblacion Oeste"],
          },
          {
            code: "city-urdaneta",
            name: "Urdaneta",
            type: "city",
            barangays: ["Cabuloan", "Labney", "Nancamalyan", "Polong", "Pugaro", "San Manuel"],
          },
        ],
      },
      {
        code: "prov-la-union",
        name: "La Union",
        cities: [
          {
            code: "city-san-fernando-launion",
            name: "San Fernando (La Union)",
            type: "city",
            barangays: ["Ilocanos Norte", "Ilocanos Sur", "Poblacion", "San Agustin", "Sevilla"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-iii",
    name: "Central Luzon",
    sortOrder: 4,
    provinces: [
      {
        code: "prov-bulacan",
        name: "Bulacan",
        cities: [
          {
            code: "city-malolos",
            name: "Malolos",
            type: "city",
            barangays: ["Atlag", "Bagong Bayan", "Bagumbayan", "Catmon", "Guinhawa", "Longos", "Mambang", "Panghulo", "San Agustin", "Sumapang Matanda"],
          },
          {
            code: "city-san-jose-del-monte",
            name: "San Jose del Monte",
            type: "city",
            barangays: ["Fatima", "Minuyan", "Paradise", "Poblacion", "Tungkang Mangga"],
          },
          {
            code: "city-marilao",
            name: "Marilao",
            type: "city",
            barangays: ["Abangan Norte", "Abangan Sur", "Ibayo", "Lias", "Patubig", "Poblacion I"],
          },
          {
            code: "city-meycauayan",
            name: "Meycauayan",
            type: "city",
            barangays: ["Bagbaguin", "Bahay Pare", "Calabuso", "Lawa", "Malhacan", "Pandayan", "Saluysoy", "Tugatog"],
          },
          {
            code: "city-bocaue",
            name: "Bocaue",
            type: "city",
            barangays: ["Bambang", "Batia", "Caingin", "Entablado", "Lolomboy", "Turo"],
          },
        ],
      },
      {
        code: "prov-pampanga",
        name: "Pampanga",
        cities: [
          {
            code: "city-san-fernando-pampanga",
            name: "City of San Fernando",
            type: "city",
            barangays: ["Del Pilar", "Lourdes", "Malino", "San Jose", "San Nicolas", "Sindalan", "Sto. Rosario", "Telabastagan"],
          },
          {
            code: "city-angeles",
            name: "Angeles",
            type: "city",
            barangays: ["Amsic", "Balibago", "Malabanias", "Marisol", "Pampang", "Pandan", "Pulung Cacutud"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-calabarzon",
    name: "CALABARZON",
    sortOrder: 5,
    provinces: [
      {
        code: "prov-cavite",
        name: "Cavite",
        cities: [
          {
            code: "city-cavite-city",
            name: "Cavite City",
            type: "city",
            barangays: ["Caridad", "Dalahican", "Maburaya", "San Antonio I", "San Roque I", "Santa Cruz"],
          },
          {
            code: "city-imus",
            name: "Imus",
            type: "city",
            barangays: ["Alapan", "Anabu", "Bucandala", "Carsadang Bago", "Magdalo", "Pag-asa", "Pasong Buaya", "Poblacion", "Tanzang Luma"],
          },
          {
            code: "city-bacoor",
            name: "Bacoor",
            type: "city",
            barangays: ["Alima", "Aniban", "Bayanan", "Habay I", "Mabolo", "Molino I", "Panapaan", "Salinas"],
          },
          {
            code: "city-dasmarinas",
            name: "Dasmarinas",
            type: "city",
            barangays: ["Biclatan", "Burol", "Paliparan", "Salitran", "San Agustin I", "San Antonio", "Sampaloc"],
          },
          {
            code: "city-general-trias",
            name: "General Trias",
            type: "municipality",
            barangays: ["Arnaldo", "Buenavista", "Governor Ferrer", "Manggahan", "Navarro", "Pasong Camachile"],
          },
          {
            code: "city-tagaytay",
            name: "Tagaytay",
            type: "city",
            barangays: ["Bagong Tubig", "Calabuso", "Dapdap East", "Kaybagal South", "Maitim", "San Jose"],
          },
          {
            code: "city-trece-martires",
            name: "Trece Martires",
            type: "city",
            barangays: ["Cabezas", "De Ocampo", "Osorio", "San Agustin", "San Nicolas"],
          },
        ],
      },
      {
        code: "prov-laguna",
        name: "Laguna",
        cities: [
          {
            code: "city-calamba",
            name: "Calamba",
            type: "city",
            barangays: ["Banlic", "Barandal", "Batino", "Canlubang", "Halang", "Laguerta", "Mapagong", "Parian", "Real", "San Cristobal", "Sirang Lupa", "Turbina"],
          },
          {
            code: "city-santa-rosa",
            name: "Santa Rosa",
            type: "city",
            barangays: ["Aplaya", "Balibago", "Caingin", "Dita", "Don Jose", "Labas", "Market Area", "Pook", "Pulong Santa Cruz", "Tagapo"],
          },
          {
            code: "city-binan",
            name: "Biñan",
            type: "city",
            barangays: ["Canlalay", "Casile", "Dela Paz", "Ganado", "Langkiwa", "Malamig", "Mamplasan", "San Antonio", "Santo Nino", "Timbauan"],
          },
          {
            code: "city-san-pedro",
            name: "San Pedro",
            type: "city",
            barangays: ["Calendola", "Landayan", "Langgam", "Magsaysay", "Narra", "Poblacion", "Riverside", "San Antonio", "United Bayanihan"],
          },
          {
            code: "city-cabuyao",
            name: "Cabuyao",
            type: "city",
            barangays: ["Baclaran", "Banay-Banay", "Bigaa", "Casilayan", "Diezmo", "Gulod", "Mamatid", "Marinig", "Niugan", "Pulo", "Sala", "San Isidro", "Santa Rosa"],
          },
          {
            code: "city-san-pablo",
            name: "San Pablo",
            type: "municipality",
            barangays: ["Bagong Anyo", "Concepcion", "Del Remedio", "Dolores", "San Rafael", "San Roque", "Santa Monica", "Santo Angel"],
          },
          {
            code: "city-los-banos",
            name: "Los Baños",
            type: "city",
            barangays: ["Anos", "Bagong Silang", "Batong Malake", "Baybayin", "Lalakay", "Maahas", "Malinta", "Masili", "San Antonio", "Timugan"],
          },
        ],
      },
      {
        code: "prov-batangas",
        name: "Batangas",
        cities: [
          {
            code: "city-batangas-city",
            name: "Batangas City",
            type: "city",
            barangays: ["Balagtas", "Bolbok", "Calicanto", "Cuta", "Ilijan", "Kumintang Ibaba", "Libjo", "Pallocan", "San Isidro", "Sampaga", "Tabangao"],
          },
          {
            code: "city-lipa",
            name: "Lipa",
            type: "city",
            barangays: ["Adya", "Antipolo Del Norte", "Balintawak", "Banaybanay", "Biga", "Dagatan", "Inosluban", "Marawoy", "Sabang"],
          },
          {
            code: "city-tanauan",
            name: "Tanauan",
            type: "city",
            barangays: ["Darasa", "Hidalgo", "Malvar", "Natatas", "Pagaspas", "Santo Nino", "Suplang"],
          },
          {
            code: "city-santo-tomas",
            name: "Santo Tomas",
            type: "municipality",
            barangays: ["San Agustin", "San Felix", "San Jose", "San Rafael", "San Vicente", "Santiago"],
          },
        ],
      },
      {
        code: "prov-rizal",
        name: "Rizal",
        cities: [
          {
            code: "city-antipolo",
            name: "Antipolo",
            type: "city",
            barangays: ["Calawis", "Cupang", "Dalig", "Mayamot", "Munting Dilao", "San Isidro", "San Jose", "San Roque", "Santa Cruz", "Sumulong"],
          },
          {
            code: "city-cainta",
            name: "Cainta",
            type: "municipality",
            barangays: ["San Andres", "San Isidro", "San Juan", "San Roque", "Santa Rosa", "Santo Domingo", "Sto. Nino"],
          },
          {
            code: "city-taytay",
            name: "Taytay",
            type: "city",
            barangays: ["Dolores", "San Isidro", "San Juan", "Santa Ana"],
          },
          {
            code: "city-san-mateo",
            name: "San Mateo",
            type: "municipality",
            barangays: ["AMPID", "Banaba", "Dulong Bayan", "Guinayang", "Malanday", "Maly", "Santa Ana", "Santa Elena"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-vi",
    name: "Western Visayas",
    sortOrder: 6,
    provinces: [
      {
        code: "prov-iloilo",
        name: "Iloilo",
        cities: [
          {
            code: "city-iloilo-city",
            name: "Iloilo City",
            type: "city",
            barangays: ["Arevalo", "City Proper", "Jaro", "Lapuz", "Mandurriao", "Molo"],
          },
        ],
      },
      {
        code: "prov-negros-occidental",
        name: "Negros Occidental",
        cities: [
          {
            code: "city-bacolod",
            name: "Bacolod",
            type: "city",
            barangays: ["Banago", "Mansilingan", "Singcang-Airport", "Tangub", "Villamonte"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-vii",
    name: "Central Visayas",
    sortOrder: 7,
    provinces: [
      {
        code: "prov-cebu",
        name: "Cebu",
        cities: [
          {
            code: "city-cebu-city",
            name: "Cebu City",
            type: "city",
            barangays: ["Apas", "Banilad", "Guadalupe", "Lahug", "Mambaling", "Punta Princesa", "Talamban", "Zapatera"],
          },
          {
            code: "city-mandaue",
            name: "Mandaue",
            type: "city",
            barangays: ["Centro", "Looc", "Opao", "Paknaan", "Subangdaku", "Tipolo"],
          },
          {
            code: "city-lapu-lapu",
            name: "Lapu-Lapu",
            type: "city",
            barangays: ["Babag", "Basak", "Buaya", "Gun-ob", "Maribago", "Pajo", "Pusok"],
          },
          {
            code: "city-talisay",
            name: "Talisay",
            type: "city",
            barangays: ["Lawis", "Mohon", "San Roque", "Tabunok"],
          },
        ],
      },
      {
        code: "prov-bohol",
        name: "Bohol",
        cities: [
          {
            code: "city-tagbilaran",
            name: "Tagbilaran",
            type: "city",
            barangays: ["Cogon", "Dampas", "Dao", "Manga", "Mansasa", "San Isidro"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-x",
    name: "Northern Mindanao",
    sortOrder: 8,
    provinces: [
      {
        code: "prov-misamis-oriental",
        name: "Misamis Oriental",
        cities: [
          {
            code: "city-cagayan-de-oro",
            name: "Cagayan de Oro",
            type: "city",
            barangays: ["Balulang", "Bulua", "Carmen", "Gusa", "Kauswagan", "Lapasan", "Macasandig", "Tablon"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-xi",
    name: "Davao Region",
    sortOrder: 9,
    provinces: [
      {
        code: "prov-davao-del-sur",
        name: "Davao del Sur",
        cities: [
          {
            code: "city-davao-city",
            name: "Davao City",
            type: "city",
            barangays: ["Bangkal", "Buhangin", "Calinan", "Matina", "Poblacion", "Talomo", "Toril", "Ulas"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-xii",
    name: "SOCCSKSARGEN",
    sortOrder: 10,
    provinces: [
      {
        code: "prov-south-cotabato",
        name: "South Cotabato",
        cities: [
          {
            code: "city-general-santos",
            name: "General Santos",
            type: "city",
            barangays: ["Bula", "Conel", "Fatima", "Lagao", "Mabuhay", "San Isidro"],
          },
        ],
      },
    ],
  },
  {
    code: "reg-ii",
    name: "Cagayan Valley Region",
    sortOrder: 11,
    provinces: [],
  },
  {
    code: "reg-mimaropa",
    name: "MIMAROPA",
    sortOrder: 12,
    provinces: [],
  },
  {
    code: "reg-v",
    name: "Bicol Region",
    sortOrder: 13,
    provinces: [],
  },
  {
    code: "reg-viii",
    name: "Eastern Visayas",
    sortOrder: 14,
    provinces: [],
  },
  {
    code: "reg-ix",
    name: "Zamboanga Peninsula",
    sortOrder: 15,
    provinces: [],
  },
  {
    code: "reg-xiii",
    name: "Caraga",
    sortOrder: 16,
    provinces: [],
  },
  {
    code: "reg-barmm",
    name: "Bangsamoro Autonomous Region",
    sortOrder: 17,
    provinces: [],
  },
];

async function main() {
  let provinceCount = 0;
  let cityCount = 0;
  let barangayCount = 0;

  for (const r of DATA) {
    const region = await prisma.phRegion.upsert({
      where: { code: r.code },
      update: { name: r.name, sortOrder: r.sortOrder },
      create: { code: r.code, name: r.name, sortOrder: r.sortOrder },
    });

    for (const p of r.provinces) {
      provinceCount += 1;
      const province = await prisma.phProvince.upsert({
        where: { code: p.code },
        update: { name: p.name, regionId: region.id },
        create: { code: p.code, name: p.name, regionId: region.id },
      });

      for (const city of p.cities) {
        cityCount += 1;
        const created = await prisma.phCity.upsert({
          where: { code: city.code },
          update: { name: city.name, type: city.type, provinceId: province.id },
          create: { code: city.code, name: city.name, type: city.type, provinceId: province.id },
        });

        await prisma.phBarangay.deleteMany({ where: { cityId: created.id } });
        if (city.barangays.length > 0) {
          await prisma.phBarangay.createMany({
            data: city.barangays.map((name, i) => ({
              code: `${city.code}-bg${(i + 1).toString().padStart(2, "0")}`,
              name,
              cityId: created.id,
            })),
          });
          barangayCount += city.barangays.length;
        }
      }
    }
  }

  console.log(
    `PH address seed complete: ${DATA.length} regions, ${provinceCount} provinces, ${cityCount} cities/municipalities, ${barangayCount} barangays.`,
  );
  console.log("NOTE: curated subset only — full PSGC dataset is PENDING.");
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});