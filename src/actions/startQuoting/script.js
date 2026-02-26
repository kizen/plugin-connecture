// Configuration Constants
const CONFIG = {
  FIELD_MAPPINGS: {
    CONTACT: {
      birthdate: "birthday",
      firstName: "first_name",
      lastName: "last_name",
      emailAddress: "email",
      homePhone: "home_phone",
      workPhone: "business_phone",
      cellPhone: "mobile_phone",
      genderID: "gender",
      mbi: "medicare_number",
    },
    ADDRESS: {
      address1: "street_address_1",
      address2: "street_address_2",
      city: "city",
      state: "state",
      zip: "zipcode",
      county: "county",
    },
    PROVIDER: {
      npi: "npi_ce9d20",
    },
  },
  ENVIRONMENTS: {
    connecture_integration_jsastaging: {
      plan_compare_service_name: "plancomparejsastaging",
      tools_service_name: "toolsjsastaging",
      sso_url: "https://alg.oktapreview.com/app/alg_connecture2024_1/exka2wr7dsAauvHfE1d7/sso/saml",
      relay_state_url: "https://jsa7.staging.destinationrx.com/PC/Agent/Profile/EditProfile",
    },
    connecture_integration_jsa: {
      plan_compare_service_name: "plancomparejsa",
      tools_service_name: "toolsjsa",
      sso_url: "https://agentsso.okta.com/app/agentsso_jsaconnecturedrx2024_1/exk5ephj96v5antsj4h7/sso/saml",
      relay_state_url: "https://jsa7.destinationrx.com/PC/Agent/Profile/EditProfile",
    },
  },
  REQUIRED_ADDRESS_FIELDS: ["street_address_1", "city", "zipcode", "state"],
  SPECIAL_FIELDS: ["drugs", "providers", "pharmacies"],
};

// Main execution - top level like the working version
this.setIndicator("button");

try {
  // Initialize configuration and validate setup
  const { pluginConfig, envConfig, contact, obj } = await initializeConfig.call(this);

  // Process contact fields
  const fields = await processContactFields.call(this, contact, obj);

  // Validate required data
  const validationResult = await validateRequiredData.call(this, fields);
  if (!validationResult) {
    this.setIndicator("none");
    throw new Error("Validation failed");
  }

  // Extract related session names early (no API dependency)
  const relatedSessionNames = getRelatedSessionNames(fields);

  // Run session management and related records processing in parallel
  const [sessionData, { drugs, providers, pharmacies }] = await Promise.all([
    handleSessionManagement.call(this, fields, contact, pluginConfig, envConfig, relatedSessionNames),
    processRelatedRecords.call(this, fields, obj, envConfig.tools_service_name, contact.id),
  ]);

  // If user cancelled, exit gracefully
  if (!sessionData) {
    this.setIndicator("none");
    return;
  }

  // Launch Connecture
  await launchConnecture.call(this, sessionData, fields, { drugs, providers, pharmacies }, envConfig, pluginConfig);
} catch (error) {
  this.setIndicator("none");
  throw error;
}

// Helper Functions
async function initializeConfig() {
  // Run all API calls in parallel
  const [pluginConfig, contact, obj] = await Promise.all([
    this.get(`/employee/mine/configs/plugins/${this.args.pluginId}`),
    this.currentEntity(),
    this.currentObject(),
  ]);

  if (!pluginConfig?.config?.npn) {
    throw new Error("Your employee record is not configured with your NPN. Please contact your administrator");
  }

  const business = this.currentBusiness;
  const envKey = Object.keys(business?.entitlements).find((key) => CONFIG.ENVIRONMENTS[key]);
  const envConfig = CONFIG.ENVIRONMENTS[envKey];

  if (!envConfig) {
    throw new Error("Your business is not configured to connect to Connecture.");
  }

  return { pluginConfig, envConfig, contact, obj };
}

async function processContactFields(contact, obj) {
  const fields = {};
  const fieldnames = {};

  // Build field name mapping
  obj.fields.forEach((field) => {
    fieldnames[field.id] = field.name;
    if (field.is_default) {
      fields[field.name] = {
        field: field.id,
        field_display_name: field.display_name,
        field_type: field.field_type,
        value: contact[field.name],
        name: null,
      };
    }
  });

  // Converts multival fields to arrays
  contact.fields.forEach((fieldval) => {
    const fieldName = fieldnames[fieldval.field];
    if (!fieldName) return;

    if (fields[fieldName]) {
      fields[fieldName] = Array.isArray(fields[fieldName])
        ? [...fields[fieldName], fieldval]
        : [fields[fieldName], fieldval];
    } else {
      fields[fieldName] = fieldval;
    }
  });

  return fields;
}

async function validateRequiredData(fields) {
  // Check for medicare number
  if (!fields.medicare_number) {
    const result = await this.prompt({
      title: "Missing Medicare Number",
      confirmButton: {
        label: "Continue Without",
        variant: "standard",
        color: "primary",
      },
      cancelButton: { label: "Cancel", variant: "standard", color: "warning" },
      content: [
        {
          type: "description",
          content:
            "Continuing without a Medicare number will not allow you to search for plans. Please enter the Medicare number in the contact record before proceeding.",
          widthPercent: 100,
        },
        { type: "spacer", height: 10, widthPercent: 100 },
      ],
    });

    if (result.canceled) return false;
  }

  // Check for required address fields
  const missingAddressFields = CONFIG.REQUIRED_ADDRESS_FIELDS.filter((field) => !fields[field]);
  if (missingAddressFields.length > 0) {
    throw new Error(`Missing required address fields: ${missingAddressFields.join(", ")}`);
  }

  return true;
}

function getSpecialFields(objFields) {
  const specialFields = {};
  CONFIG.SPECIAL_FIELDS.forEach((fieldName) => {
    const field = objFields.find((f) => f.name === fieldName);
    if (field) {
      specialFields[`${fieldName}Field`] = field;
    }
  });
  return specialFields;
}

async function processRelatedRecords(fields, obj, toolsServiceName, contactId) {
  const specialFields = getSpecialFields(obj.fields);
  const results = { pharmacies: [], providers: [], drugs: [] };

  // Process all related records in parallel where possible
  const promises = [];

  if (specialFields.pharmaciesField) {
    promises.push(processPharmacies.call(this, specialFields.pharmaciesField, toolsServiceName, contactId));
  }

  if (specialFields.providersField) {
    promises.push(processProviders.call(this, specialFields.providersField, toolsServiceName, contactId));
  }

  if (specialFields.drugsField) {
    promises.push(processDrugs.call(this, specialFields.drugsField, toolsServiceName, contactId));
  }

  const promiseResults = await Promise.allSettled(promises);

  // Handle results
  let resultIndex = 0;
  if (specialFields.pharmaciesField) {
    results.pharmacies = promiseResults[resultIndex].status === "fulfilled" ? promiseResults[resultIndex].value : [];
    resultIndex++;
  }
  if (specialFields.providersField) {
    results.providers = promiseResults[resultIndex].status === "fulfilled" ? promiseResults[resultIndex].value : [];
    resultIndex++;
  }
  if (specialFields.drugsField) {
    results.drugs = promiseResults[resultIndex].status === "fulfilled" ? promiseResults[resultIndex].value : [];
  }

  return results;
}

async function processForField(field, contactId) {
  const entity = await this.get(`/client/${contactId}?field_category=${encodeURIComponent(field.category)}`);
  return entity.fields.filter((f) => f.field === field.id);
}

function removeCountryCode(phoneNumber) {
  return phoneNumber ? phoneNumber.replace(/^\+\d/, "") : phoneNumber;
}

function buildContactRecordObject(fieldNameMapper, fields, staticValues = {}) {
  const connectureFields = Object.entries(fieldNameMapper).reduce((acc, [connectureField, kizenField]) => {
    if (!fields[kizenField]) return acc;

    let value = fields[kizenField].name ?? fields[kizenField].value;

    // Apply field-specific transformations
    if (kizenField === "birthday" && value) {
      value = new Date(value).toISOString();
    } else if (kizenField.includes("phone") && value) {
      value = removeCountryCode(value);
    } else if (kizenField === "gender" && value) {
      value = value === "Male" ? 1 : value === "Female" ? 2 : value;
    }

    if (value) {
      acc[connectureField] = value;
    }
    return acc;
  }, {});

  return { ...connectureFields, ...staticValues };
}

async function processPharmacies(pharmaciesField, toolsServiceName, contactId) {
  const pharmacyIds = await processForField.call(this, pharmaciesField, contactId);
  if (pharmacyIds.length === 0) return [];

  const pharmacyData = await Promise.allSettled(
    pharmacyIds.map((pharmacy) =>
      this.get(
        `/external-integrations/proxy/connecture/${toolsServiceName}/quoting-api/Pharmacies/${pharmacy.name}?PharmacyIDType=2`,
      ),
    ),
  );

  return pharmacyData.filter((result) => result.status === "fulfilled" && result.value).map((result) => result.value);
}

async function processProviders(providersField, toolsServiceName, contactId) {
  const providerIds = await processForField.call(this, providersField, contactId);
  if (providerIds.length === 0) return [];

  const providerRecords = await Promise.allSettled(
    providerIds.map((provider) => this.getEntity(providersField.relation.related_object, provider.value)),
  );

  const validProviders = providerRecords
    .filter((result) => result.status === "fulfilled")
    .map((result) => {
      const record = result.value;
      record.providerFieldValues = Object.values(record.fields).reduce((acc, field) => {
        acc[field.name] = typeof field.value === "string" ? field.value : field.value?.name;
        return acc;
      }, {});
      return record;
    });

  if (validProviders.length === 0) return [];

  try {
    const npis = validProviders
      .map((p) => encodeURIComponent(p.name))
      .filter(Boolean)
      .join(",");
    if (!npis) return [];

    const connectureResponse = await this.get(
      `/external-integrations/proxy/connecture/${toolsServiceName}/quoting-api/Providers/GetByNPIs?npis=${npis}`,
    );

    if (!connectureResponse?.Providers) return [];

    const providerMap = validProviders.reduce((acc, record) => {
      if (record.name) acc[record.name] = record;
      return acc;
    }, {});

    return connectureResponse.Providers.map((provider) => {
      const record = providerMap[provider.NPI];
      const providerZip = record?.providerFieldValues?.zip;

      const selectedAddress =
        provider.Addresses?.find((addr) => addr.ZipCode === providerZip) ?? provider.Addresses?.[0];

      return selectedAddress
        ? {
            ProviderID: provider.Id,
            isPrimary: provider.IsPrimary,
            isVBC: provider.IsVBC,
            isNewPatient: provider.IsNewPatient,
            vbcOrganizationName: provider.VBCOrganizationName,
            addressId: selectedAddress.Id,
          }
        : null;
    }).filter(Boolean);
  } catch (error) {
    // Error already logged, return empty array
    return [];
  }
}

async function getDrugData(drugId) {
  const drugRecord = await this.get(`/records/medications_medication/${drugId}`);

  const drugData = {
    ndc: null,
    quantity: null,
    frequency: null,
    name: null,
  };

  for (const field of Object.values(drugRecord.fields)) {
    if (field.name === "ndc") {
      drugData.ndc = field.value;
    } else if (field.name === "qty") {
      drugData.quantity = field.value;
    } else if (field.name === "freq") {
      drugData.frequency = field.value;
    } else if (field.name === "name") {
      drugData.name = field.value;
    }
  }

  return drugData;
}

async function processDrugs(drugsField, toolsServiceName, contactId) {
  const drugIds = await processForField.call(this, drugsField, contactId);
  if (drugIds.length === 0) return [];

  try {
    // Get NDC, quantity, and frequency for each drug from Kizen
    const drugDataList = await Promise.allSettled(drugIds.map((drug) => getDrugData.call(this, drug.value)));

    const validDrugData = drugDataList
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value);

    if (validDrugData.length === 0) return [];

    // Format the drug data for submission - only ndc, frequency, and quantity needed
    // Fallback to name if ndc is missing
    const formattedDrugs = validDrugData.map((drugData) => ({
      ndc: drugData.ndc || drugData.name,
      daysOfSupply: drugData.frequency || 30,
      userQuantity: drugData.quantity || 30,
    }));

    return formattedDrugs;
  } catch (error) {
    console.error("Error processing drugs:", error);
    return [];
  }
}

async function getCountyCode(fields, toolsServiceName) {
  if (!fields?.zipcode?.value || !fields?.county?.name) return null;

  try {
    const countyResponse = await this.get(
      `/external-integrations/proxy/connecture/${toolsServiceName}/quoting-api/Counties/${fields.zipcode.value}`,
    );

    if (!Array.isArray(countyResponse)) return null;

    const foundCounty = countyResponse.find(
      (county) => county.CountyName?.toLowerCase() === fields.county.name.toLowerCase(),
    );

    return foundCounty?.CountyFIPS || null;
  } catch (error) {
    // Silently handle county lookup errors
    return null;
  }
}

async function buildProfileData(fields, toolsServiceName) {
  const countyCode = await getCountyCode.call(this, fields, toolsServiceName);

  const profileData = buildContactRecordObject(CONFIG.FIELD_MAPPINGS.CONTACT, fields);

  const staticAddressValues = countyCode ? { county: countyCode } : {};
  const memberAddressData = buildContactRecordObject(CONFIG.FIELD_MAPPINGS.ADDRESS, fields, staticAddressValues);

  // Remove county if not found
  if (!countyCode) {
    delete memberAddressData.county;
  }

  return { profileData, memberAddressData };
}

async function createSession(pluginConfig, envConfig) {
  const searchSessionPayload = { BLUserName: pluginConfig.config.npn };

  const result = await this.post(
    `/external-integrations/proxy/connecture/${envConfig.plan_compare_service_name}/quoting-api/session`,
    [searchSessionPayload],
  );

  if (!result || !result[0]) {
    throw new Error("Unable to create session");
  }

  return {
    sessionId: result[0].SessionID,
    ssoValue: result[0].SSOValue,
  };
}

async function searchMembers(fields, sessionId, envConfig) {
  const memberSearchResults = {};

  if (fields.medicare_number?.value) {
    try {
      const results = await this.get(
        `/external-integrations/proxy/connecture/${
          envConfig.plan_compare_service_name
        }/quoting-api/session/${sessionId}/MemberSearch/GetMemberEnrollments?hicn=${encodeURIComponent(
          fields.medicare_number.value,
        )}`,
      );

      if (Array.isArray(results)) {
        results.forEach((member) => {
          if (member.SSOValue && !memberSearchResults[member.SSOValue]) {
            memberSearchResults[member.SSOValue] = member;
          }
        });
      }
    } catch (error) {
      // Silently handle search errors, return empty results
    }
  }

  return Object.values(memberSearchResults);
}

function extractSessionId(fullName) {
  return fullName?.startsWith("CNX_") ? fullName.substring(4) : null;
}

function getRelatedSessionNames(fields) {
  if (!fields.primary_for_saved_session_records) return [];

  const sessions = Array.isArray(fields.primary_for_saved_session_records)
    ? fields.primary_for_saved_session_records
    : [fields.primary_for_saved_session_records];

  return sessions.map((session) => extractSessionId(session.name)).filter(Boolean);
}

function sortMemberMatches(memberResults, relatedSessionNames) {
  return memberResults.sort((a, b) => {
    const aIsRelated = relatedSessionNames.includes(a.SSOValue) ? 1 : 0;
    const bIsRelated = relatedSessionNames.includes(b.SSOValue) ? 1 : 0;

    if (aIsRelated !== bIsRelated) {
      return bIsRelated - aIsRelated; // Related members first
    }

    const aDate = new Date(a.ProfileDate);
    const bDate = new Date(b.ProfileDate);
    return bDate - aDate; // Most recent profile date first
  });
}

async function handleMemberSelection(memberMatches, relatedSessionNames, currentSsoValue) {
  if (memberMatches.length === 0) return currentSsoValue; // No members found, use the initial random SSO value

  const result = await this.prompt({
    title: "Select Member Record",
    confirmButton: { label: "Continue", variant: "standard", color: "primary" },
    cancelButton: {
      label: "Create New Member",
      variant: "text",
      color: "secondary",
    },
    content: [
      {
        type: "description",
        content: "Record(s) with the same Medicare number were found in Connecture. Please choose one to continue.",
        widthPercent: 100,
      },
      { type: "spacer", height: 10, widthPercent: 100 },
      {
        type: "dropdown",
        id: "selectedMember",
        options: memberMatches.map((member) => ({
          label: `${member.FirstName} ${member.LastName} ${
            relatedSessionNames.includes(member.SSOValue) ? "(Linked to this contact) " : ""
          }- Created ${new Date(member.ProfileDate).toLocaleDateString()}`,
          value: member.SSOValue,
        })),
        widthPercent: 100,
        defaultValue: memberMatches[0].SSOValue,
      },
    ],
  });

  if (result.canceled && result.eventSource === "close") {
    return null; // Signal that user wants to exit completely
  }

  return result.canceled ? currentSsoValue : result.values.selectedMember.value; // Use initial SSO if creating new member
}

async function handleSessionManagement(fields, contact, pluginConfig, envConfig, relatedSessionNames) {
  // Create session
  const { sessionId, ssoValue: initialSsoValue } = await createSession.call(this, pluginConfig, envConfig);

  // Search for existing members and immediately show selection (depends on sessionId)
  const memberResults = await searchMembers.call(this, fields, sessionId, envConfig);
  const sortedMembers = sortMemberMatches(memberResults, relatedSessionNames);

  // Handle member selection immediately - this is the critical path
  const finalSsoValue = await handleMemberSelection.call(this, sortedMembers, relatedSessionNames, initialSsoValue);

  // If user cancelled (clicked X), exit gracefully
  if (finalSsoValue === null) {
    return null;
  }

  // Manage saved session records
  const manageResult = await manageSavedSessionRecord.call(this, finalSsoValue, contact);

  if (manageResult === null) {
    return null; // Exit if user cancelled during session record management
  }

  return { sessionId, ssoValue: finalSsoValue };
}

async function manageSavedSessionRecord(ssoValue, contact) {
  const filteredSessionResponse = await this.post(`/records/sunfire_saved_sessions/search?search=CNX_${ssoValue}`, {
    field_names: ["name", "id", "applicant", "most_recent_for_applicant"],
    search_within_field_names: ["name"],
  });

  if (!filteredSessionResponse?.results) {
    throw new Error("Error searching for existing saved session records.");
  }

  const filteredSessions = filteredSessionResponse.results;

  if (filteredSessions.length === 0) {
    // Create new saved session record
    await this.post("/records/sunfire_saved_sessions/add", {
      fields: [
        { name: "name", value: `CNX_${ssoValue}` },
        { name: "applicant", value: { id: contact.id } },
        { name: "most_recent_for_applicant", value: { id: contact.id } },
      ],
    });
  } else if (filteredSessions.length === 1) {
    const sessionRecord = filteredSessions[0];
    const sessionApplicantField = Object.values(sessionRecord.fields).find((f) => f.name === "applicant");

    if (sessionApplicantField?.value?.id && sessionApplicantField.value.id !== contact.id) {
      const proceedResult = await this.prompt({
        title: "Existing Session Record Found",
        confirmButton: {
          label: "Continue",
          variant: "standard",
          color: "primary",
        },
        cancelButton: {
          label: "View Contact",
          variant: "text",
          color: "secondary",
        },
        content: [
          {
            type: "description",
            content: `This member is already linked to a different contact (${sessionApplicantField?.value?.first_name} ${sessionApplicantField?.value?.last_name}).`,
            widthPercent: 100,
          },
          { type: "spacer", height: 10, widthPercent: 100 },
          {
            type: "description",
            content:
              "If you continue, the member will be linked to the current contact, and existing data in Connecture will be overwritten with the current contact's information.",
            widthPercent: 100,
          },
          { type: "spacer", height: 10, widthPercent: 100 },
          {
            type: "description",
            content: "Do you want to continue?",
            widthPercent: 100,
          },
          { type: "spacer", height: 10, widthPercent: 100 },
        ],
      });

      if (proceedResult.canceled && proceedResult.eventSource === "close") {
        return null; // Exit if user cancels
      } else if (proceedResult.canceled) {
        this.openWindow(`/client/${sessionApplicantField.value.id}/details`);
        return null; // Exit after opening contact
      }
    }

    // Update the record to ensure only current contact is linked
    await this.patch(`/records/sunfire_saved_sessions/${sessionRecord.id}`, {
      fields: [
        { name: "applicant", value: { id: contact.id } },
        { name: "most_recent_for_applicant", value: { id: contact.id } },
      ],
    });
  } else {
    throw new Error(`Multiple saved session records found for CNX_${ssoValue}.`);
  }
}

async function launchConnecture(sessionData, fields, relatedData, envConfig, pluginConfig) {
  const { profileData, memberAddressData } = await buildProfileData.call(this, fields, envConfig.tools_service_name);
  const { drugs, providers, pharmacies } = relatedData;
  const { ssoValue } = sessionData;

  // Update the session with the Kizen contact record to create/update member
  const updateSessionPayload = {
    ssoValue,
    BLUserName: pluginConfig.config.npn,
    birthdate: profileData.birthdate,
    Profile: {
      ...profileData,
      ...(Object.keys(memberAddressData).length > 0 && {
        memberAddress: memberAddressData,
      }),
    },
    ...(providers.length > 0 && { providers }),
    ...(pharmacies.length > 0 && { pharmacies }),
    ...(drugs.length > 0 && { dosages: drugs }),
  };

  await this.post(
    `/external-integrations/proxy/connecture/${envConfig.plan_compare_service_name}/quoting-api/session`,
    [updateSessionPayload],
  );

  this.showToast("Successfully Created Connecture Session", {
    variant: "success",
  });

  // Launch Connecture
  const dest = `${envConfig.sso_url}?SSOValue=${encodeURIComponent(
    ssoValue,
  )}&RelayState=${encodeURIComponent(envConfig.relay_state_url)}`;

  this.openWindow(dest);
  this.setIndicator("none");
}
